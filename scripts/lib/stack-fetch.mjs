import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { posix, withFileLock } from './common.mjs';
import { StackPackError, normalizeRepoUrl, repoCacheId } from './stack-pack.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  // 阻断 SSH 交互提示；不关闭主机密钥校验。
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

export function stackCacheRoot(env = process.env) {
  return resolve(env.DEVFLOW_CACHE_DIR || join(homedir(), '.devflow', 'cache', 'stacks'));
}

export function gitRun(args, { cwd = process.cwd(), input = undefined, timeout = 120000 } = {}) {
  const result = spawnSync('git', args, {
    cwd, input, encoding: 'utf8', timeout, env: GIT_ENV,
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

/** clone 与 fetch 共用同一把 failClosed 锁，避免并发争用 refs/*.lock。 */
function withCacheLock(repoGit, fn) {
  return withFileLock(join(dirname(repoGit), 'locks', 'repo'), fn, {
    failClosed: true,
    timeoutMs: 30000,
  });
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
  withFileLock(join(dirs.locks, 'repo'), () => {
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
  }, { failClosed: true });
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

/** 把 ref 明确落到同名本地引用：不带目标端的 fetch 只写 FETCH_HEAD，缓存里的旧值不会更新。 */
function refreshSpecs(value) {
  if (value.startsWith('refs/')) return [`+${value}:${value}`];
  return [
    `+refs/heads/${value}:refs/heads/${value}`,
    `+refs/tags/${value}:refs/tags/${value}`,
  ];
}

/** 强制刷新 ref：分支可能只前进不后退，缓存里的旧值不能代表远程现状。 */
export function refreshRef({ repoGit, ref, run = gitRun }) {
  const value = safeGitValue(ref, 'ref');
  withCacheLock(repoGit, () => {
    let last = null;
    for (const spec of refreshSpecs(value)) {
      for (const args of [
        ['fetch', '--filter=blob:none', 'origin', spec],
        ['fetch', 'origin', spec],
      ]) {
        try {
          run(args, { cwd: repoGit });
          return;
        } catch (err) {
          last = err;
        }
      }
    }
    throw new StackPackError(`无法刷新 ref：${value}${last ? `：${last.message}` : ''}`, 'STACK_GIT');
  });
}

export function fetchCommit({ repoGit, commit, ref = null, offline = false, run = gitRun }) {
  const target = safeGitValue(commit, 'commit');
  const refValue = ref == null ? null : safeGitValue(ref, 'ref');
  withCacheLock(repoGit, () => {
    // 对象已在本地时不联网；部分克隆只缺 blob，这里只确认 commit 可达。
    if (revParse(repoGit, target, run)) return;
    if (offline) {
      throw new StackPackError(`离线模式下无法拉取 commit：${target}`, 'STACK_OFFLINE');
    }
    const candidates = [];
    if (refValue) candidates.push(['fetch', '--filter=blob:none', 'origin', refValue]);
    candidates.push(['fetch', 'origin', target]);
    candidates.push(['fetch', 'origin']);
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
