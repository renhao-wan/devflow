// scripts/lib/stack-install.mjs
import {
  cpSync, existsSync, readdirSync, lstatSync, readFileSync, mkdirSync, renameSync, rmSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  contentHash, ensureDir, isPathInside, isRealPathInside, loadHub, posix, withFileLock, writeAtomic,
} from './common.mjs';
import {
  dropHubOwnership, readLock, readSources, stackPaths, writeLock, writeSources,
} from './stack-ledger.mjs';
import { isValidStackName } from './stacks.mjs';
import { mergeTexts } from './upstream.mjs';

const DEFAULT_OPS = { renameSync, rmSync };

function tag() {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

function assertStackName(installedAs) {
  if (!isValidStackName(installedAs)) {
    // 不回显非法值，避免日志注入或暴露构造中的路径。
    throw new Error('栈名不合法：只允许 [a-z0-9][a-z0-9_-]*');
  }
}

function assertInsideProject(root, path, label) {
  if (!isPathInside(root, path) || !isRealPathInside(root, path)) {
    throw new Error(`${label} 越界（可能被 junction/符号链接引到项目外）`);
  }
}

/** 安装会写入的四类路径都在项目内；junction/符号链接不能把它们引到外面。 */
function assertInstallPaths(root, installedAs) {
  const paths = stackPaths(root);
  assertInsideProject(root, paths.stackDir(installedAs), '目标目录');
  assertInsideProject(root, paths.basesDir(installedAs), 'bases 目录');
  assertInsideProject(root, paths.stagingRoot, 'staging 目录');
  assertInsideProject(root, paths.trashRoot, 'trash 目录');
  return paths;
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
  // 预检与提交之间 hub 目录可能被替换成 junction，锁内移动前必须重新校验。
  assertStackName(installedAs);
  const paths = assertInstallPaths(root, installedAs);
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
    const rollbackErrors = rollback(tx, { target, bases, trash, installedAs, ops });
    if (rollbackErrors.length) {
      onWarn(`回滚未能完全恢复：${rollbackErrors.join('；')}；备份保留在 .claude/.stack-trash`);
    }
    throw err;
  }
  // 账本提交成功后才清理旧目录与旧 bases 备份；清理失败不能让已完成的安装报失败。
  try {
    ops.rmSync(trash, { recursive: true, force: true });
  } catch {
    onWarn('安装已完成，但清理临时备份失败；可手动删除 .claude/.stack-trash');
  }

  for (const message of dropHubOwnership(root, installedAs)) onWarn(message);

  try {
    if (source.type === 'git') {
      const lock = readLock(root);
      lock.packs[installedAs] = lockEntryFor({ installedAs, source, pack });
      writeLock(root, lock);
    } else if (existsSync(paths.lock)) {
      const lock = readLock(root);
      if (lock.packs[installedAs]) {
        delete lock.packs[installedAs];
        writeLock(root, lock);
      }
    }
  } catch (err) {
    onWarn(`写入 stack-lock.yaml 失败：${err.message}；运行 devflow stack lock 重建`);
  }
  return action;
}

function rollback(tx, { target, bases, trash, installedAs, ops }) {
  const errors = [];
  const step = (label, fn) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${label}：${err.message}`);
    }
  };
  // 先把本次换入的新 bases 移走，否则恢复旧 bases 时会撞上非空目录；
  // 再恢复旧目录与旧 bases。任一步失败都继续后续恢复，最后才决定是否删除备份。
  if (tx.placedBases) {
    step('移出新 bases', () => {
      ensureDir(trash);
      ops.renameSync(bases, join(trash, `${installedAs}-new-bases`));
    });
  }
  if (tx.placedTarget) step('移除新目录', () => ops.rmSync(target, { recursive: true, force: true }));
  if (tx.movedTarget) {
    step('恢复旧目录', () => {
      ensureDir(dirname(target));
      ops.renameSync(join(trash, installedAs), target);
    });
  }
  if (tx.movedBases) {
    step('恢复旧 bases', () => {
      ensureDir(dirname(bases));
      ops.renameSync(join(trash, `${installedAs}-bases`), bases);
    });
  }
  if (!errors.length) {
    step('清理备份', () => ops.rmSync(trash, { recursive: true, force: true }));
  }
  return errors;
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
  // 校验必须在任何写入之前：非法栈名与越界 junction 都不能进入 staging。
  assertStackName(installedAs);
  const paths = assertInstallPaths(root, installedAs);
  const target = paths.stackDir(installedAs);
  const conflictsWith = declaredConflict(root, installedAs);
  if (conflictsWith) {
    throw new Error(`.claude/hub/stacks/${installedAs} 已声明给 ${conflictsWith}；先修正 hub.yaml`);
  }
  const lock = readLock(root);
  const record = sources.packs[installedAs] || null;
  const snap = targetSnapshot(root, installedAs, pack);
  const preflight = classifyInstall({
    installedAs,
    targetExists: snap.exists,
    targetMatches: snap.matches,
    record,
    lockEntry: lock.packs[installedAs] || null,
    force,
    source,
  });
  if (preflight === 'conflict') {
    throw new Error(`目标目录已存在且内容不同：.claude/hub/stacks/${installedAs}；确认覆盖请加 --force`);
  }
  if (preflight === 'other-owner') {
    throw new Error(`目标目录已由其他安装占用：.claude/hub/stacks/${installedAs}；先运行 devflow stack remove`);
  }

  const stageRoot = join(paths.stagingRoot, tag());
  const stagedTarget = join(stageRoot, 'target');
  const stagedBases = join(stageRoot, 'bases');
  writePackTree(stagedTarget, pack);
  writePackTree(stagedBases, pack);
  const localHashes = hashTree(stagedTarget, pack.files.map((file) => file.rel));
  const nextRecord = ledgerRecord({ installedAs, pack, source, localHashes });
  let action;
  try {
    action = commitStagedTree({
      root, installedAs, source, pack, record: nextRecord,
      stagedTarget, stagedBases, force, ops, onWarn,
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  if (!noGen && generate) {
    try {
      generate(root);
    } catch {
      onWarn('安装已完成，但生成技能失败；修正 hub.yaml 或栈声明后运行 node scripts/gen-claude-skills.mjs');
    }
  }
  return { action };
}

function readTreeTexts(dir) {
  const map = new Map();
  for (const file of listTree(dir)) map.set(file.rel, readFileSync(file.abs, 'utf8'));
  return map;
}

/**
 * 文本相等按设计 §13 归一 EOL 后比较，避免仅换行符不同被当成手改。
 */
function sameText(a, b) {
  return a !== undefined && b !== undefined && contentHash(a) === contentHash(b);
}

/** 冲突备份不覆盖已有文件：优先 <rel>.bak，再依次 <rel>.bak.1、.bak.2…… */
function pickBackupRel(targetDir, rel) {
  let candidate = `${rel}.bak`;
  let index = 0;
  while (existsSync(join(targetDir, ...candidate.split('/')))) {
    index += 1;
    candidate = `${rel}.bak.${index}`;
  }
  return candidate;
}

/**
 * 以 bases 为 base、当前目录为 local、新包为 theirs 计算更新动作，不落盘。
 * 只读取项目内路径；栈名与路径先过校验，避免 junction 把读取引到项目外。
 */
export function planPackUpdate({ root, installedAs, pack }) {
  assertStackName(installedAs);
  const paths = assertInstallPaths(root, installedAs);
  const targetDir = paths.stackDir(installedAs);
  const current = readTreeTexts(targetDir);
  const base = readTreeTexts(paths.basesDir(installedAs));
  const theirs = new Map(pack.files.map((file) => [file.rel, file.text]));
  const rels = [...new Set([...current.keys(), ...base.keys(), ...theirs.keys()])].sort();
  const ops = [];
  const warnings = [];
  for (const rel of rels) {
    const b = base.get(rel);
    const l = current.get(rel);
    const t = theirs.get(rel);
    if (t !== undefined && l === undefined && b === undefined) {
      ops.push({ type: 'write', rel, text: t });
    } else if (t !== undefined && l === undefined) {
      // 本地删除的文件不自动恢复；账本会记为缺失，交由 doctor 报告。
      ops.push({ type: 'missing', rel });
    } else if (t !== undefined && b === undefined) {
      ops.push(sameText(l, t) ? { type: 'same', rel } : {
        type: 'conflict', rel, reason: '本地已有同名文件', backupRel: pickBackupRel(targetDir, rel),
      });
    } else if (t !== undefined) {
      // 先判本地与新版是否已一致：三方全等时应是 same，而不是重复写入。
      if (sameText(l, t)) ops.push({ type: 'same', rel });
      else if (sameText(l, b)) ops.push({ type: 'write', rel, text: t });
      else {
        const merged = mergeTexts(b, l, t);
        // 不拼接 mergeTexts 的原始错误：可能包含临时路径或文本片段。
        if (merged.ok) ops.push({ type: 'write', rel, text: merged.content, merged: true });
        else {
          ops.push({
            type: 'conflict',
            rel,
            reason: merged.conflicts ? '三方合并冲突' : '合并失败',
            backupRel: pickBackupRel(targetDir, rel),
          });
        }
      }
    } else if (b !== undefined) {
      if (l === undefined) ops.push({ type: 'missing', rel });
      else if (sameText(l, b)) ops.push({ type: 'delete', rel });
      else {
        ops.push({ type: 'keep', rel });
        warnings.push(`${rel}：包已删除但本地改过，保留本地文件`);
      }
    } else {
      ops.push({ type: 'orphan', rel });
    }
  }
  return { ops, warnings };
}

/** 把当前目录复制进 staging，并按计划落盘；冲突文件保留本地内容并写同名 .bak。 */
function stageCurrentTree(root, installedAs, staged, ops) {
  const current = stackPaths(root).stackDir(installedAs);
  ensureDir(dirname(staged));
  if (existsSync(current)) {
    cpSync(current, staged, { recursive: true });
  } else {
    ensureDir(staged);
  }
  for (const op of ops) {
    const abs = join(staged, ...op.rel.split('/'));
    if (op.type === 'write') {
      ensureDir(dirname(abs));
      writeAtomic(abs, op.text);
    } else if (op.type === 'delete') {
      rmSync(abs, { force: true });
    } else if (op.type === 'conflict' && op.backupRel && existsSync(abs)) {
      const backupAbs = join(staged, ...op.backupRel.split('/'));
      ensureDir(dirname(backupAbs));
      cpSync(abs, backupAbs);
    }
  }
}

/**
 * 计划在锁外基于快照计算，写入由 commitStagedTree 在安装锁内重新裁决；
 * 这里不能自己再套安装锁，否则会与 commitStagedTree 嵌套死锁。
 */
export function applyPackUpdate({
  root, installedAs, pack, source, force = false,
  noGen = false, generate = null, onWarn = () => {},
}) {
  assertStackName(installedAs);
  const paths = assertInstallPaths(root, installedAs);
  if (!existsSync(paths.stackDir(installedAs))) {
    throw new Error('目标目录缺失，不能执行更新；请先运行 devflow stack restore 或重新 add');
  }
  const plan = planPackUpdate({ root, installedAs, pack });
  for (const warning of plan.warnings) onWarn(warning);
  for (const op of plan.ops) {
    if (op.type === 'conflict') {
      onWarn(`${op.rel}：${op.reason}；已保留本地内容并写入 ${op.backupRel}`);
    }
  }
  const stageRoot = join(paths.stagingRoot, tag());
  const stagedTarget = join(stageRoot, 'target');
  const stagedBases = join(stageRoot, 'bases');
  try {
    stageCurrentTree(root, installedAs, stagedTarget, plan.ops);
    writePackTree(stagedBases, pack);
    // local 必须取 staging 的实际内容：冲突与缺失文件不能用包内哈希冒充干净写入。
    // base 始终用新包哈希，把本次上游内容记为下一次更新的基线。
    const localHashes = hashTree(stagedTarget, pack.files.map((file) => file.rel));
    const record = ledgerRecord({ installedAs, pack, source, localHashes });
    commitStagedTree({
      root, installedAs, source, pack, record, stagedTarget, stagedBases, force, onWarn,
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
  if (!noGen && generate) {
    try {
      generate(root);
    } catch {
      onWarn('更新已完成，但生成技能失败；修正 hub.yaml 或栈声明后运行 node scripts/devflow-gen.mjs');
    }
  }
  return { ops: plan.ops };
}

/**
 * 采纳内容与包一致的既有目录：补 bases 与账本。
 * 哈希、bases 替换与账本写入都在安装锁内完成，避免与并发安装互相覆盖。
 */
export function adoptExisting({ root, installedAs, pack, source, onWarn = () => {} }) {
  // 校验必须在任何写入与目录读取之前。
  assertStackName(installedAs);
  const paths = assertInstallPaths(root, installedAs);
  withFileLock(join(paths.stagingRoot, 'install'), () => {
    // 入口与加锁之间目录可能被替换成 junction，锁内移动前重新校验。
    assertInstallPaths(root, installedAs);
    const target = paths.stackDir(installedAs);
    const bases = paths.basesDir(installedAs);
    const localHashes = hashTree(target, pack.files.map((file) => file.rel));
    const absent = pack.files.filter((file) => localHashes.get(file.rel) === null);
    if (absent.length) {
      throw new Error(`目标目录缺少文件，不能采纳：${absent.map((file) => file.rel).join('、')}`);
    }

    const stageRoot = join(paths.stagingRoot, tag());
    const stagedBases = join(stageRoot, 'bases');
    const trash = join(paths.trashRoot, tag(), `${installedAs}-bases`);
    const tx = { movedOld: false, placedNew: false };
    const rollbackErrors = [];
    const step = (label, fn) => {
      try {
        fn();
      } catch (err) {
        rollbackErrors.push(`${label}：${err.message}`);
      }
    };
    try {
      writePackTree(stagedBases, pack);
      if (existsSync(bases)) {
        ensureDir(dirname(trash));
        renameSync(bases, trash);
        tx.movedOld = true;
      }
      ensureDir(dirname(bases));
      renameSync(stagedBases, bases);
      tx.placedNew = true;
      // 账本是提交点：锁内重新读取，避免覆盖并发写入的其他栈记录。
      const latest = readSources(root);
      writeSources(root, {
        ...latest,
        schemaVersion: 1,
        packs: { ...latest.packs, [installedAs]: ledgerRecord({ installedAs, pack, source, localHashes }) },
      });
    } catch (err) {
      // 回滚各步独立执行：任一步失败不阻断后续恢复，全部成功才清理备份。
      if (tx.placedNew) step('移除新 bases', () => rmSync(bases, { recursive: true, force: true }));
      if (tx.movedOld) {
        step('恢复旧 bases', () => {
          ensureDir(dirname(bases));
          renameSync(trash, bases);
        });
      }
      if (rollbackErrors.length) {
        onWarn(`回滚未能完全恢复：${rollbackErrors.join('；')}；备份保留在 .claude/.stack-trash`);
      }
      throw err;
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
    // 账本已提交且没有回滚遗留；清理备份失败不能让采纳报失败。
    if (tx.movedOld && rollbackErrors.length === 0) {
      try {
        rmSync(dirname(trash), { recursive: true, force: true });
      } catch {
        onWarn('采纳已完成，但清理临时备份失败；可手动删除 .claude/.stack-trash');
      }
    }
  }, { failClosed: true, timeoutMs: 10000 });

  // dropHubOwnership 只返回 warning，不抛出；逐条交给 onWarn。
  for (const message of dropHubOwnership(root, installedAs)) onWarn(message);

  try {
    if (source.type === 'git') {
      const lock = readLock(root);
      lock.packs[installedAs] = lockEntryFor({ installedAs, source, pack });
      writeLock(root, lock);
    } else if (existsSync(paths.lock)) {
      // local 来源不得凭空创建 lock；只在已有该条目时移除。
      const lock = readLock(root);
      if (lock.packs[installedAs]) {
        delete lock.packs[installedAs];
        writeLock(root, lock);
      }
    }
  } catch (err) {
    onWarn(`写入 stack-lock.yaml 失败：${err.message}；运行 devflow stack lock 重建`);
  }
}
