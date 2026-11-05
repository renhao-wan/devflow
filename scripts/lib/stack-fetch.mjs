import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, posix, withFileLock, writeAtomic } from './common.mjs';
import {
  PACK_LIMITS, StackPackError, normalizeRepoUrl, readPackFromDir, repoCacheId,
} from './stack-pack.mjs';
import { isValidStackName } from './stacks.mjs';

// clone 与 fetch 共用同一套锁参数：staleMs 必须远大于单次 gitRun 的 120s 超时，
// 也要覆盖连续多次 fetch 尝试，避免长网络操作被当成残留锁抢占。
const CACHE_LOCK = Object.freeze({
  failClosed: true,
  timeoutMs: 10 * 60 * 1000,
  staleMs: 30 * 60 * 1000,
});

const FULL_FETCHES = [
  ['fetch', '--filter=blob:none', 'origin', '+refs/heads/*:refs/heads/*'],
  ['fetch', 'origin', '+refs/heads/*:refs/heads/*'],
  ['fetch', '--filter=blob:none', 'origin', '+refs/tags/*:refs/tags/*'],
  ['fetch', 'origin', '+refs/tags/*:refs/tags/*'],
];

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // 尊重调用方已设置的命令；默认阻断 SSH 交互但不关闭主机密钥校验。
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
  };
}

export function stackCacheRoot(env = process.env) {
  return resolve(env.DEVFLOW_CACHE_DIR || join(homedir(), '.devflow', 'cache', 'stacks'));
}

export function gitRun(args, {
  cwd = process.cwd(), input = undefined, timeout = 120000, env = {},
} = {}) {
  const result = spawnSync('git', args, {
    cwd, input, encoding: 'utf8', timeout, env: { ...gitEnv(), ...env },
  });
  if (result.error) throw new StackPackError(`无法执行 git：${result.error.message}`, 'STACK_GIT');
  if (result.status !== 0) {
    throw new StackPackError(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout || '').trim()}`, 'STACK_GIT');
  }
  return result.stdout;
}

/** 进入 git 参数的值不能是选项或含控制字符；错误消息不回显原值。 */
function safeGitValue(value, label) {
  const text = String(value ?? '');
  if (!text || text.startsWith('-') || /[\0\r\n]/.test(text)) {
    throw new StackPackError(`非法 ${label}`, 'STACK_REF');
  }
  return text;
}

/** 传入的 url 必须已归一化；cacheId 的二次归一化要沿用同一个 allowFile。 */
function repoDirs(normalized, cacheRoot, allowFile) {
  const cacheId = repoCacheId(normalized, { allowFile });
  const dir = join(cacheRoot, cacheId);
  return { cacheId, dir, repoGit: join(dir, 'repo.git'), locks: join(dir, 'locks') };
}

function assertCacheUsable(dirs) {
  if (!existsSync(join(dirs.repoGit, 'HEAD'))) {
    throw new StackPackError(
      `缓存损坏（缺少 HEAD）：${posix(dirs.repoGit)}；请删除该缓存目录后重试`,
      'STACK_CACHE',
    );
  }
}

/**
 * withFileLock 自身只抛普通 Error（锁超时或 mkdir 失败），这里统一转成 STACK_LOCK；
 * fn 内部抛出的错误保持原样，避免把 git 失败误报成锁问题。
 */
function withFileLockOrStack(file, fn) {
  let entered = false;
  try {
    return withFileLock(file, () => {
      entered = true;
      return fn();
    }, CACHE_LOCK);
  } catch (err) {
    if (err instanceof StackPackError) throw err;
    if (entered) throw err;
    throw new StackPackError(`无法获取缓存锁：${posix(file)}.lock`, 'STACK_LOCK');
  }
}

function withCacheLock(repoGit, fn) {
  return withFileLockOrStack(join(dirname(repoGit), 'locks', 'repo'), fn);
}

export function ensureRepo({ url, cacheRoot = stackCacheRoot(), offline = false, allowFile = false, run = gitRun }) {
  const normalized = normalizeRepoUrl(url, { allowFile });
  const dirs = repoDirs(normalized, cacheRoot, allowFile);
  if (existsSync(dirs.repoGit)) {
    assertCacheUsable(dirs);
    return { repoGit: dirs.repoGit, cacheId: dirs.cacheId };
  }
  if (offline) {
    throw new StackPackError(`离线模式下缓存不存在：${normalized}`, 'STACK_OFFLINE');
  }
  mkdirSync(dirs.dir, { recursive: true });
  const tmp = join(dirs.dir, `repo.git.tmp-${process.pid}`);
  // withFileLock 会自动追加 .lock，因此这里传不带后缀的 basename。
  withFileLockOrStack(join(dirs.locks, 'repo'), () => {
    if (existsSync(dirs.repoGit)) {
      assertCacheUsable(dirs);
      return;
    }
    rmSync(tmp, { recursive: true, force: true });
    try {
      try {
        run(['clone', '--bare', '--filter=blob:none', '--', normalized, tmp], { cwd: dirs.dir });
      } catch {
        rmSync(tmp, { recursive: true, force: true });
        run(['clone', '--bare', '--', normalized, tmp], { cwd: dirs.dir });
      }
      renameSync(tmp, dirs.repoGit);
    } finally {
      // 两次 clone 都失败或 rename 失败时都不能留下半成品缓存。
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  return { repoGit: dirs.repoGit, cacheId: dirs.cacheId };
}

function revParse(repoGit, ref, run) {
  const value = safeGitValue(ref, 'ref');
  try {
    return run(['rev-parse', '--verify', `${value}^{commit}`], { cwd: repoGit }).trim();
  } catch {
    return null;
  }
}

/**
 * 本地引用必须显式写入，不能只依赖 FETCH_HEAD：
 * bare 缓存没有 remote.origin.fetch，裸 ref 的 fetch 不会创建新分支/标签。
 */
function refreshSpecs(value) {
  if (value.startsWith('refs/')) return [`+${value}:${value}`];
  return [
    `+refs/heads/${value}:refs/heads/${value}`,
    `+refs/tags/${value}:refs/tags/${value}`,
  ];
}

function refspecCandidates(value) {
  return refreshSpecs(value).flatMap((spec) => [
    ['fetch', '--filter=blob:none', 'origin', spec],
    ['fetch', 'origin', spec],
  ]);
}

/** commit 既可能是 SHA，也可能是 resolveCommit 传入的 ref 名，按形态选择抓取方式。 */
function fetchCandidates(value) {
  if (SHA_RE.test(value)) {
    return [
      ['fetch', '--filter=blob:none', 'origin', value],
      ['fetch', 'origin', value],
    ];
  }
  return refspecCandidates(value);
}

/** 强制刷新 ref：分支可能只前进不后退，缓存里的旧值不能代表远程现状。 */
export function refreshRef({ repoGit, ref, run = gitRun }) {
  const value = safeGitValue(ref, 'ref');
  withCacheLock(repoGit, () => {
    let last = null;
    for (const args of refspecCandidates(value)) {
      try {
        run(args, { cwd: repoGit });
        return;
      } catch (err) {
        last = err;
      }
    }
    throw new StackPackError(`无法刷新 ref：${value}${last ? `：${last.message}` : ''}`, 'STACK_GIT');
  });
}

export function fetchCommit({
  repoGit, commit = null, ref = null, offline = false, run = gitRun,
}) {
  const commitValue = commit == null ? null : safeGitValue(commit, 'commit');
  const refValue = ref == null ? null : safeGitValue(ref, 'ref');
  const target = commitValue ?? refValue;
  if (!target) throw new StackPackError('非法 commit', 'STACK_REF');
  withCacheLock(repoGit, () => {
    // 对象已在本地时不联网；部分克隆只缺 blob，这里只确认 commit 可达。
    if (revParse(repoGit, target, run)) return;
    if (offline) {
      throw new StackPackError(`离线模式下无法拉取 commit：${target}`, 'STACK_OFFLINE');
    }
    const candidates = [];
    const seen = new Set();
    const add = (args) => {
      const key = args.join('\0');
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(args);
    };
    if (refValue) fetchCandidates(refValue).forEach(add);
    if (commitValue) fetchCandidates(commitValue).forEach(add);
    FULL_FETCHES.forEach(add);

    let last = null;
    for (const args of candidates) {
      try {
        run(args, { cwd: repoGit });
        if (revParse(repoGit, target, run)) return;
      } catch (err) {
        last = err;
      }
    }
    if (!revParse(repoGit, target, run)) {
      throw new StackPackError(`无法获取 commit ${target}${last ? `：${last.message}` : ''}`, 'STACK_GIT');
    }
  });
}

// offline 只允许解析缓存里已有的 ref：rev-parse 读本地对象库，不联网；
// ref 缺失时 fetchCommit 会加锁并直接抛 STACK_OFFLINE。
export function resolveCommit({ repoGit, ref = 'main', offline = false, run = gitRun }) {
  const value = safeGitValue(ref, 'ref');
  let commit = revParse(repoGit, value, run);
  if (!commit) {
    fetchCommit({ repoGit, commit: value, ref: value, offline, run });
    commit = revParse(repoGit, value, run);
  }
  if (!commit) throw new StackPackError(`找不到 ref：${value}`, 'STACK_REF');
  return commit;
}

// ---------------------------------------------------------------------------
// 快照：按 commit 物化包目录
// ---------------------------------------------------------------------------

const SNAPSHOT_SCHEMA = 1;
const GIT_BUFFER_LIMIT = 64 * 1024 * 1024;
const META_SUFFIX = '.meta.json';

/** 包名会进入快照目录和锁文件名，必须先过与 index/stack.json 相同的规则。 */
function assertPackId(packId) {
  if (!isValidStackName(packId)) throw new StackPackError('非法包名', 'STACK_PATH');
  return packId;
}

/** commit 直接拼进路径与 git 参数，只接受 7-40 位十六进制。 */
function assertCommit(commit) {
  const value = String(commit ?? '');
  if (!SHA_RE.test(value)) throw new StackPackError('非法 commit', 'STACK_REF');
  return value;
}

/**
 * 树条目来自仓库内容。Windows 上反斜杠可能被当成路径分隔符，
 * 冒号可能变成盘符/ADS，空段与 . / .. 会逃出 staging，一律在写盘前拒绝。
 */
function safeTreeRel(rel) {
  const value = String(rel ?? '');
  if (!value || /[\\:\0\r\n]/.test(value)
    || value.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StackPackError('非法包内路径', 'STACK_PATH');
  }
  return value;
}

/** `ls-tree -- <path>` 也会接受越界路径，必须在进入 git 前拒绝。 */
function safePackPath(packPath) {
  const value = String(packPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = value.split('/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes(':')
    || /[\0\r\n]/.test(value)
    || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new StackPackError('非法包路径', 'STACK_PATH');
  }
  return value;
}

/** 二进制安全地读 git 输出：blob 内容不能走 utf8 解码。 */
function gitRunBuffer(args, { cwd, input, timeout = 120000 } = {}) {
  const result = spawnSync('git', args, {
    cwd, input, timeout, env: gitEnv(), maxBuffer: GIT_BUFFER_LIMIT,
  });
  if (result.error) throw new StackPackError(`无法执行 git：${result.error.message}`, 'STACK_GIT');
  if (result.status !== 0) {
    const detail = result.stderr ? Buffer.from(result.stderr).toString('utf8').trim() : '';
    throw new StackPackError(`git 对象读取失败${detail ? `：${detail}` : ''}`, 'STACK_GIT');
  }
  return result.stdout;
}

function listTreeEntries(repoGit, commit, packPath) {
  const out = gitRun(['ls-tree', '-r', '-z', commit, '--', packPath], { cwd: repoGit });
  const prefix = `${packPath}/`;
  const entries = [];
  for (const item of out.split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    if (tab < 0) throw new StackPackError('无法解析 git 树条目', 'STACK_GIT');
    const [mode, type, hash] = item.slice(0, tab).split(/\s+/);
    const full = item.slice(tab + 1);
    if (!full.startsWith(prefix)) continue;
    entries.push({ mode, type, hash, rel: safeTreeRel(full.slice(prefix.length)) });
  }
  return entries;
}

/** 先取大小再做限额检查，避免把超大 blob 整个读进内存。 */
function blobSizes(repoGit, hashes) {
  const unique = [...new Set(hashes)];
  if (!unique.length) return new Map();
  const out = gitRun(['cat-file', '--batch-check'], {
    cwd: repoGit,
    input: `${unique.join('\n')}\n`,
  });
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, type, sizeText] = line.split(' ');
    if (type === 'blob' && Number.isFinite(Number(sizeText))) map.set(sha, Number(sizeText));
  }
  return map;
}

function readBlobs(repoGit, hashes) {
  const unique = [...new Set(hashes)];
  if (!unique.length) return new Map();
  const buf = gitRunBuffer(['cat-file', '--batch'], {
    cwd: repoGit,
    input: `${unique.join('\n')}\n`,
  });
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const parts = buf.slice(pos, nl).toString('utf8').split(' ');
    // header 无法解析时无法定位下一条，按现有方式退出。
    if (parts.length < 3) break;
    const [sha, type, sizeText] = parts;
    const size = Number(sizeText);
    if (!Number.isInteger(size) || size < 0) break;
    const start = nl + 1;
    // 非 blob 仍带 size 字节内容与一个尾部换行，必须一并跳过，否则后续条目错位。
    if (type !== 'blob') {
      pos = start + size + 1;
      continue;
    }
    out.set(sha, buf.subarray(start, start + size));
    pos = start + size + 1;
  }
  return out;
}

/** 读取 commit 中的单个文件（用于 index.json），不检出工作树。 */
export function readFileAtCommit({ repoGit, commit, file, offline = false }) {
  const safeCommit = assertCommit(commit);
  const value = String(file ?? '').replace(/\\/g, '/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes(':')
    || /[\0\r\n]/.test(value)
    || value.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StackPackError('非法文件路径', 'STACK_PATH');
  }
  try {
    // partial clone 读取缺失 blob 会触发 lazy fetch（联网）；离线必须显式禁止。
    return gitRun(['show', `${safeCommit}:${value}`], {
      cwd: repoGit,
      env: offline ? { GIT_NO_LAZY_FETCH: '1' } : {},
    });
  } catch (err) {
    // 不拼接底层 git 错误：它可能包含远端地址或文件片段。
    if (offline) throw new StackPackError('离线模式下无法读取缓存内容', 'STACK_OFFLINE');
    throw err;
  }
}

/**
 * 设计 §5：快照与锁都在仓库级缓存目录下，repoGit 本身就在该目录里。
 * 传入的 cacheRoot 不参与路径计算。
 */
function snapshotPaths(repoGit, commit, packId) {
  const safeCommit = assertCommit(commit);
  const safePackId = assertPackId(packId);
  const repoRoot = dirname(repoGit);
  const dir = join(repoRoot, 'snapshots', safeCommit);
  return {
    repoRoot,
    snapshotDir: join(dir, safePackId),
    metaFile: join(dir, `${safePackId}${META_SUFFIX}`),
  };
}

/**
 * 完整性标记与全部文件哈希都匹配才算可用；任何异常都降级为 false，
 * 由调用方删除并重新物化。
 */
export function verifySnapshot({ snapshotDir, metaFile, packId, commit }) {
  assertPackId(packId);
  if (!snapshotDir || !metaFile || !existsSync(metaFile) || !existsSync(snapshotDir)) return false;
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  } catch {
    return false;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  if (meta.schemaVersion !== SNAPSHOT_SCHEMA || meta.commit !== commit || meta.packId !== packId) {
    return false;
  }
  const files = meta.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
  try {
    const pack = readPackFromDir(snapshotDir, { packId });
    if (pack.files.length !== Object.keys(files).length) return false;
    return pack.files.every((item) => Object.prototype.hasOwnProperty.call(files, item.rel)
      && files[item.rel] === item.hash);
  } catch {
    return false;
  }
}

export function materializeSnapshot({
  repoGit, commit, packId, packPath, cacheRoot, indexEntry = null,
  offline = false, loaderFiles = null, pluginVersion = null,
}) {
  const safeCommit = assertCommit(commit);
  const safePackId = assertPackId(packId);
  const safePath = safePackPath(packPath);
  const paths = snapshotPaths(repoGit, safeCommit, safePackId);
  ensureDir(dirname(paths.snapshotDir));
  return withFileLockOrStack(
    join(paths.repoRoot, 'locks', `snapshot-${safeCommit}-${safePackId}`),
    () => {
      if (verifySnapshot({ ...paths, commit: safeCommit, packId: safePackId })) {
        const pack = readPackFromDir(paths.snapshotDir, {
          packId: safePackId, indexEntry, loaderFiles, pluginVersion,
        });
        return { snapshotDir: paths.snapshotDir, metaFile: paths.metaFile, pack };
      }
      // 设计 §5.3：offline 只读已验证快照。部分克隆缺 blob 时
      // cat-file 会隐式联网，因此这里绝不能落到任何 git 命令。
      if (offline) {
        throw new StackPackError(
          `离线模式下没有可用快照：${safeCommit.slice(0, 8)}/${safePackId}`,
          'STACK_OFFLINE',
        );
      }
      const staging = join(dirname(paths.snapshotDir), `${safePackId}.staging-${process.pid}`);
      rmSync(staging, { recursive: true, force: true });
      try {
        const entries = listTreeEntries(repoGit, safeCommit, safePath);
        if (!entries.length) throw new StackPackError('commit 中没有包路径', 'STACK_PACK');
        if (entries.length > PACK_LIMITS.files) {
          throw new StackPackError(`包内文件超过 ${PACK_LIMITS.files} 个`, 'STACK_SIZE');
        }
        for (const entry of entries) {
          if (entry.mode === '120000' || entry.mode === '160000' || entry.type !== 'blob') {
            throw new StackPackError('包内不允许符号链接或子模块', 'STACK_PATH');
          }
        }
        // 先用 --batch-check 拿大小：超限必须在读取内容之前拒绝。
        const sizes = blobSizes(repoGit, entries.map((entry) => entry.hash));
        let total = 0;
        for (const entry of entries) {
          const size = sizes.get(entry.hash);
          if (!Number.isFinite(size)) {
            throw new StackPackError(`读取 blob 大小失败：${entry.rel}`, 'STACK_GIT');
          }
          if (size > PACK_LIMITS.fileBytes) {
            throw new StackPackError(`单文件超过 1 MiB：${entry.rel}`, 'STACK_SIZE');
          }
          total += size;
          if (total > PACK_LIMITS.packBytes) {
            throw new StackPackError('整包超过 10 MiB', 'STACK_SIZE');
          }
        }
        const blobs = readBlobs(repoGit, entries.map((entry) => entry.hash));
        for (const entry of entries) {
          const data = blobs.get(entry.hash);
          if (!data) throw new StackPackError(`读取 blob 失败：${entry.rel}`, 'STACK_GIT');
          const text = data.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(data)) {
            throw new StackPackError(`不是 UTF-8 文本：${entry.rel}`, 'STACK_ENCODING');
          }
          const abs = join(staging, ...entry.rel.split('/'));
          ensureDir(dirname(abs));
          writeAtomic(abs, text);
        }
        // staging 内再做一次完整校验：白名单、哈希与兼容性都在这里定案。
        const pack = readPackFromDir(staging, {
          packId: safePackId, indexEntry, loaderFiles, pluginVersion,
        });
        const meta = {
          schemaVersion: SNAPSHOT_SCHEMA,
          commit: safeCommit,
          packId: safePackId,
          files: Object.fromEntries(pack.files.map((item) => [item.rel, item.hash])),
        };
        rmSync(paths.snapshotDir, { recursive: true, force: true });
        // meta 在包目录外，且先于 rename 写：rename 失败时 verify 会发现快照缺失并重建。
        writeAtomic(paths.metaFile, `${JSON.stringify(meta, null, 2)}\n`);
        renameSync(staging, paths.snapshotDir);
        return { snapshotDir: paths.snapshotDir, metaFile: paths.metaFile, pack };
      } catch (err) {
        rmSync(staging, { recursive: true, force: true });
        throw err;
      }
    },
  );
}

/**
 * 供调用方传入用户级缓存根（stackCacheRoot()），逐个 <repo-id>/snapshots 收集；
 * 也兼容直接传入单个仓库级目录。
 */
export function listSnapshots(cacheRoot) {
  const root = resolve(String(cacheRoot ?? ''));
  const candidates = [];
  const direct = join(root, 'snapshots');
  if (existsSync(direct)) {
    candidates.push(direct);
  } else {
    let names;
    try {
      names = readdirSync(root);
    } catch {
      // 根目录不存在或不可读：只读列举降级为空结果。
      return [];
    }
    for (const name of names) {
      const nested = join(root, name, 'snapshots');
      if (existsSync(nested)) candidates.push(nested);
    }
  }
  const out = [];
  for (const snapshotsDir of candidates) {
    let commits;
    try {
      commits = readdirSync(snapshotsDir);
    } catch {
      continue;
    }
    for (const commit of commits) {
      const dir = join(snapshotsDir, commit);
      let commitStat;
      try {
        commitStat = statSync(dir);
      } catch {
        // 扫描期间被并发删除（ENOENT）或不可读：跳过该条目。
        continue;
      }
      if (!commitStat.isDirectory()) continue;
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(META_SUFFIX)) continue;
        const packId = name.slice(0, -META_SUFFIX.length);
        if (!isValidStackName(packId)) continue;
        const snapshotDir = join(dir, packId);
        const metaFile = join(dir, name);
        try {
          const snapshotStat = statSync(snapshotDir);
          const metaStat = statSync(metaFile);
          if (!snapshotStat.isDirectory() || !metaStat.isFile()) continue;
          out.push({
            commit, packId, snapshotDir, metaFile, mtimeMs: metaStat.mtimeMs,
          });
        } catch {
          // 扫描期间被清理的条目直接跳过。
        }
      }
    }
  }
  out.sort((a, b) => (a.commit === b.commit
    ? a.packId.localeCompare(b.packId)
    : a.commit.localeCompare(b.commit)));
  return out;
}
