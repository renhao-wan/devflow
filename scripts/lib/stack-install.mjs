// scripts/lib/stack-install.mjs
import {
  existsSync, readdirSync, lstatSync, readFileSync, mkdirSync, renameSync, rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  contentHash, ensureDir, isPathInside, isRealPathInside, loadHub, posix, withFileLock, writeAtomic,
} from './common.mjs';
import {
  dropHubOwnership, readLock, readSources, stackPaths, writeLock,
} from './stack-ledger.mjs';

const DEFAULT_OPS = { renameSync, rmSync };

function tag() {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

function listTree(dir, rel = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (lstatSync(abs).isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...listTree(abs, childRel));
    else if (entry.isFile()) out.push({ abs, rel: childRel });
  }
  return out;
}

export function targetSnapshot(root, installedAs, pack) {
  const dir = stackPaths(root).stackDir(installedAs);
  if (!existsSync(dir)) {
    return { exists: false, matches: false, changed: [], missing: [], extra: [] };
  }
  const current = new Map(listTree(dir).map((file) => [file.rel, file.abs]));
  // Windows 文件系统大小写不敏感：按实际列出的名称匹配，避免把 Plan.md 误判成缺失。
  const byLower = new Map([...current.keys()].map((rel) => [rel.toLowerCase(), rel]));
  const expected = new Map(pack.files.map((file) => [file.rel, file]));
  const expectedLower = new Set([...expected.keys()].map((rel) => rel.toLowerCase()));
  const changed = [];
  const missing = [];
  for (const [rel, file] of expected) {
    const actualRel = current.has(rel) ? rel : byLower.get(rel.toLowerCase());
    if (!actualRel) {
      missing.push(rel);
      continue;
    }
    if (contentHash(readFileSync(current.get(actualRel), 'utf8')) !== file.hash) changed.push(rel);
  }
  const extra = [...current.keys()].filter((rel) => !expectedLower.has(rel.toLowerCase())).sort();
  return {
    exists: true,
    matches: changed.length === 0 && missing.length === 0,
    changed,
    missing,
    extra,
  };
}

export function classifyInstall({
  installedAs = null, targetExists, targetMatches = false,
  record = null, lockEntry = null, force = false, source = null,
}) {
  if (record && installedAs && record.installedAs !== installedAs) return 'other-owner';
  // 同一 installedAs 可能来自不同仓库或不同包；设计第 7 节要求先 remove。
  if (record && source && record.source) {
    const samePack = record.packId === (source.packId || record.packId);
    const sameSource = record.source === 'local'
      ? (source.type === 'local' && record.localPath === source.localPath)
      : (source.type === 'git' && record.repo === source.repo);
    if (!samePack || !sameSource) return 'other-owner';
  }
  if (targetExists) {
    if (record) return 'update';
    if (lockEntry) return targetMatches ? 'adopt' : (force ? 'takeover' : 'conflict');
    return force ? 'takeover' : 'conflict';
  }
  return record ? 'restore' : 'fresh';
}

export function writePackTree(dir, pack) {
  for (const file of pack.files) {
    const abs = join(dir, ...file.rel.split('/'));
    ensureDir(dirname(abs));
    writeAtomic(abs, file.text);
  }
}

export function ledgerRecord({ installedAs, pack, source, localHashes = null }) {
  const files = {};
  for (const file of pack.files) {
    const local = localHashes ? (localHashes.get(file.rel) ?? null) : file.hash;
    files[`.claude/hub/stacks/${installedAs}/${file.rel}`] = { base: file.hash, local };
  }
  const base = {
    installedAs,
    packId: source.packId || pack.manifest.name,
    path: source.path,
    version: pack.manifest.version,
    installedAt: new Date().toISOString(),
    files,
  };
  if (source.type === 'git') {
    return { ...base, source: 'git', repo: source.repo, ref: source.ref, commit: source.commit };
  }
  return { ...base, source: 'local', localPath: source.localPath, ref: null, commit: null };
}

/** 读取 staging 中实际写入的内容哈希；本地已删除的文件记为 null。 */
export function hashTree(dir, rels) {
  const out = new Map();
  for (const rel of rels) {
    const abs = join(dir, ...rel.split('/'));
    out.set(rel, existsSync(abs) ? contentHash(readFileSync(abs, 'utf8')) : null);
  }
  return out;
}

/** 安装事务共用入口；严格锁保证账本与目录替换不会被并发写坏。 */
export function commitStagedTree(args) {
  // withFileLock 会自动追加 .lock，这里传 install 以得到 .stack-staging/install.lock。
  const lockFile = join(stackPaths(args.root).stagingRoot, 'install');
  return withFileLock(lockFile, () => commitStagedTreeLocked(args), {
    failClosed: true, timeoutMs: 10000,
  });
}

/** lock 与账本共用同一来源身份，避免两处字段漂移。 */
export function lockEntryFor({ installedAs, source, pack }) {
  return {
    installedAs,
    repo: source.repo,
    packId: source.packId || pack.manifest.name,
    path: source.path,
    ref: source.ref,
    commit: source.commit,
    version: pack.manifest.version,
  };
}

function commitStagedTreeLocked({
  root, installedAs, source, pack, record, stagedTarget, stagedBases,
  force = false, ops = DEFAULT_OPS, onWarn = () => {},
}) {
  const paths = stackPaths(root);
  const target = paths.stackDir(installedAs);
  const bases = paths.basesDir(installedAs);
  // 锁外判定只用于提前失败；锁内必须按最新账本与目标目录重新裁决，
  // 否则两个并发安装都可能通过 fresh 预检，后到者覆盖先到者。
  const latest = readSources(root);
  const currentLock = readLock(root);
  const current = targetSnapshot(root, installedAs, pack);
  const action = classifyInstall({
    installedAs,
    targetExists: current.exists,
    targetMatches: current.matches,
    record: latest.packs[installedAs] || null,
    lockEntry: currentLock.packs[installedAs] || null,
    force,
    source,
  });
  if (action === 'conflict') {
    throw new Error(`目标目录已存在且内容不同：.claude/hub/stacks/${installedAs}；确认覆盖请加 --force`);
  }
  if (action === 'other-owner') {
    throw new Error(`目标目录已由其他安装占用：.claude/hub/stacks/${installedAs}；先运行 devflow stack remove`);
  }

  const trash = join(paths.trashRoot, tag());
  const tx = { movedTarget: false, movedBases: false, placedTarget: false, placedBases: false };
  try {
    mkdirSync(trash, { recursive: true });
    if (existsSync(target)) {
      ops.renameSync(target, join(trash, installedAs));
      tx.movedTarget = true;
    }
    if (existsSync(bases)) {
      ops.renameSync(bases, join(trash, `${installedAs}-bases`));
      tx.movedBases = true;
    }
    ensureDir(dirname(target));
    ops.renameSync(stagedTarget, target);
    tx.placedTarget = true;
    ensureDir(dirname(bases));
    ops.renameSync(stagedBases, bases);
    tx.placedBases = true;
    // 账本写入是提交点；此前任何失败都回滚。
    const nextSources = {
      ...latest,
      schemaVersion: 1,
      packs: { ...latest.packs, [installedAs]: record },
    };
    writeAtomic(paths.sources, `${JSON.stringify(nextSources, null, 2)}\n`);
  } catch (err) {
    rollback(tx, { target, bases, trash, installedAs, ops });
    throw err;
  }
  // 账本提交成功后才清理旧目录与旧 bases 备份。
  rmSync(trash, { recursive: true, force: true });

  for (const message of dropHubOwnership(root, installedAs)) onWarn(message);

  try {
    const lock = readLock(root);
    if (source.type === 'git') lock.packs[installedAs] = lockEntryFor({ installedAs, source, pack });
    else delete lock.packs[installedAs];
    writeLock(root, lock);
  } catch (err) {
    onWarn(`写入 stack-lock.yaml 失败：${err.message}；运行 devflow stack lock 重建`);
  }
}

function rollback(tx, { target, bases, trash, installedAs, ops }) {
  // 先把本次换入的新 bases 移走，否则恢复旧 bases 时会撞上非空目录；
  // 再恢复旧目录与旧 bases，最后删除备份。
  if (tx.placedBases) {
    ensureDir(trash);
    ops.renameSync(bases, join(trash, `${installedAs}-new-bases`));
  }
  if (tx.placedTarget) ops.rmSync(target, { recursive: true, force: true });
  if (tx.movedTarget) {
    ensureDir(dirname(target));
    ops.renameSync(join(trash, installedAs), target);
  }
  if (tx.movedBases) {
    ensureDir(dirname(bases));
    ops.renameSync(join(trash, `${installedAs}-bases`), bases);
  }
  ops.rmSync(trash, { recursive: true, force: true });
}

/** hub.yaml 把同一路径声明给另一个栈名时，安装会制造双 owner。 */
function declaredConflict(root, installedAs) {
  if (!existsSync(join(root, '.claude', 'hub', 'hub.yaml'))) return null;
  const { config } = loadHub(root);
  const target = posix(resolve(root, '.claude', 'hub', 'stacks', installedAs));
  const subs = config.subprojects && typeof config.subprojects === 'object' ? config.subprojects : {};
  for (const sub of Object.values(subs)) {
    if (!sub || typeof sub !== 'object') continue;
    if (!sub.stack || String(sub.stack) === installedAs) continue;
    if (sub.path && posix(resolve(root, String(sub.path))) === target) return String(sub.stack);
  }
  return null;
}

export function applyInstall({
  root, installedAs, pack, source, sources, force = false,
  noGen = false, generate = null, ops = DEFAULT_OPS, onWarn = () => {},
}) {
  const target = stackPaths(root).stackDir(installedAs);
  // --force 只覆盖目录，不能绕过“目标必须在项目内”的约束。
  if (!isPathInside(root, target) || !isRealPathInside(root, target)) {
    throw new Error(`目标目录越界（可能被 junction/符号链接引到项目外）：.claude/hub/stacks/${installedAs}`);
  }
  const conflictsWith = declaredConflict(root, installedAs);
  if (conflictsWith) {
    throw new Error(`.claude/hub/stacks/${installedAs} 已声明给 ${conflictsWith}；先修正 hub.yaml`);
  }
  const lock = readLock(root);
  const record = sources.packs[installedAs] || null;
  const snap = targetSnapshot(root, installedAs, pack);
  const action = classifyInstall({
    installedAs,
    targetExists: snap.exists,
    targetMatches: snap.matches,
    record,
    lockEntry: lock.packs[installedAs] || null,
    force,
    source,
  });
  if (action === 'conflict') {
    throw new Error(`目标目录已存在且内容不同：.claude/hub/stacks/${installedAs}；确认覆盖请加 --force`);
  }
  if (action === 'other-owner') {
    throw new Error(`目标目录已由其他安装占用：.claude/hub/stacks/${installedAs}；先运行 devflow stack remove`);
  }

  const paths = stackPaths(root);
  const stageRoot = join(paths.stagingRoot, tag());
  const stagedTarget = join(stageRoot, 'target');
  const stagedBases = join(stageRoot, 'bases');
  writePackTree(stagedTarget, pack);
  writePackTree(stagedBases, pack);
  const localHashes = hashTree(stagedTarget, pack.files.map((file) => file.rel));
  const nextRecord = ledgerRecord({ installedAs, pack, source, localHashes });
  try {
    commitStagedTree({
      root, installedAs, source, pack, record: nextRecord,
      stagedTarget, stagedBases, force, ops, onWarn,
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  if (!noGen && generate) generate(root);
  return { action };
}
