#!/usr/bin/env node
import {
  existsSync, readFileSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  argValue, contentHash, ensureDir, hasFlag, hasOption, isMain, loadHub, log, pluginInfo,
  projectRoot, warnUnknownArgs, withFileLock,
} from './lib/common.mjs';
import { LOADERS } from './lib/loaders.mjs';
import { isValidStackName } from './lib/stacks.mjs';
import {
  StackPackError, normalizeRepoUrl, readIndex, readPackFromDir, resolveIndexPack, validateIndex,
} from './lib/stack-pack.mjs';
import {
  readLock, readSources, stackPaths, writeLock, writeSources,
} from './lib/stack-ledger.mjs';
import {
  ensureRepo, fetchCommit, listSnapshots, materializeSnapshot, readFileAtCommit,
  refreshRef, resolveCommit, stackCacheRoot,
} from './lib/stack-fetch.mjs';
import {
  adoptExisting, applyInstall, applyPackUpdate, planPackUpdate, targetSnapshot,
} from './lib/stack-install.mjs';

const VALUE_FLAGS = new Set(['--root', '--repo', '--ref', '--as', '--from', '--keep-days']);

function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function pluginRootFromHere() {
  return resolve(import.meta.dirname, '..');
}

function pluginVersionOf() {
  return pluginInfo(pluginRootFromHere()).version;
}

function loaderFiles() {
  return new Set(Object.keys(LOADERS));
}

/** file:// 与本地路径只用于 `--from`；远程来源仍由 normalizeRepoUrl 拒绝。 */
function allowLocalRepo() {
  return process.env.DEVFLOW_STACK_ALLOW_LOCAL_REPO === '1';
}

/** 远端 index.json 的解析/校验失败不回显解析器原文，它可能含文件片段。 */
function remoteIndex(repoGit, commit, offline = false) {
  const text = readFileAtCommit({
    repoGit, commit, file: 'index.json', offline,
  });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StackPackError('远端 index.json 不是合法 JSON', 'STACK_INDEX');
  }
  try {
    return validateIndex(data);
  } catch {
    throw new StackPackError('远端 index.json 校验失败', 'STACK_INDEX');
  }
}

/** 人类可读输出先清洗控制字符并截断；--json 保持原值。 */
function plainTitle(value, max = 80) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 取值时把下一个 token 也当作值，避免 `--keep-days -1` 被当成缺值。 */
function optionValue(argv, name, fallback = null) {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    if (arg === name) {
      const value = argv[i + 1];
      return value === undefined ? fallback : value;
    }
  }
  return fallback;
}

/** index.json 的 path 会进入 git 参数与快照目录，非法路径用固定文案拒绝。 */
function remoteEntry(index, packId) {
  const entry = index.packs[packId];
  if (!entry) throw new StackPackError(`index.json 中没有包：${packId}`, 'STACK_INDEX');
  const value = String(entry.path ?? '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || /[\\:\0\r\n]/.test(value)
    || value.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StackPackError('包路径非法', 'STACK_PATH');
  }
  return entry;
}

/** gen 失败不回滚安装：设计文档第 8 节只要求明确警告。 */
function runGen(root) {
  const script = join(pluginRootFromHere(), 'scripts', 'gen-claude-skills.mjs');
  const res = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  if (res.status !== 0) {
    log('warn', `安装已完成，但 gen 失败：${(res.stderr || res.stdout || '').trim()}`);
    log('warn', '修正 hub.yaml 或栈声明后运行 node scripts/devflow-gen.mjs');
  }
}

/** hub.yaml 顶层 stack 与所有 subprojects.*.stack 的并集。 */
function declaredStacks(root) {
  const { config } = loadHub(root);
  const names = new Set();
  if (config.stack) names.add(String(config.stack));
  const subs = config.subprojects && typeof config.subprojects === 'object' ? config.subprojects : {};
  for (const sub of Object.values(subs)) {
    if (sub && sub.stack) names.add(String(sub.stack));
  }
  return names;
}

/** 账本里的 repo 可能是手工改过的；写入账本/lock 前必须重新归一化。 */
function ledgerRepoOf(record) {
  try {
    return normalizeRepoUrl(record.repo, { allowFile: allowLocalRepo() });
  } catch {
    // 不回显原值：它可能带凭据或控制字符。
    throw new StackPackError('安装账本中的仓库地址缺失或非法', 'STACK_LEDGER');
  }
}

function ledgerLocalPathOf(record) {
  const value = record.localPath;
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new StackPackError('安装账本中的本地路径缺失或非法', 'STACK_LEDGER');
  }
  return resolve(value);
}

/** 账本与 lock 都可能被手工改过；packId 进入日志与错误文案前必须校验。 */
function ledgerPackIdOf(record) {
  if (!isValidStackName(record.packId)) {
    throw new StackPackError('安装账本中的包名缺失或非法', 'STACK_LEDGER');
  }
  return record.packId;
}

function lockPackIdOf(entry) {
  if (!isValidStackName(entry.packId)) {
    throw new StackPackError('stack-lock.yaml 中的包名缺失或非法', 'STACK_LOCK');
  }
  return entry.packId;
}

const RESTORE_OWNER_MISMATCH = '安装来源与本地账本不一致：先运行 devflow stack remove 再 restore';

/** 设计 §7：同一 installedAs 换了 repo 或 packId 时必须先 remove，restore 不能静默换 owner。 */
function assertRestoreOwner(root, installedAs, repo, packId) {
  const record = readSources(root).packs[installedAs];
  if (!record) return;
  let recordRepo = null;
  if (record.source === 'git') {
    try {
      recordRepo = normalizeRepoUrl(record.repo, { allowFile: allowLocalRepo() });
    } catch {
      recordRepo = null;
    }
  }
  if (recordRepo !== repo || record.packId !== packId) {
    throw new Error(RESTORE_OWNER_MISMATCH);
  }
}

const SHA40_RE = /^[0-9a-f]{40}$/i;

/** 按账本记录重新解析来源：local 重读 localPath，git 刷新 ref 并物化 lock commit。 */
function loadRecordSource(record, refOverride, offline) {
  const packId = ledgerPackIdOf(record);
  if (record.source === 'local') {
    if (refOverride) throw new Error(`${record.installedAs} 是本地来源，不支持 --ref`);
    const fromRoot = ledgerLocalPathOf(record);
    const index = readIndex(fromRoot);
    const resolved = resolveIndexPack(index, packId, fromRoot);
    const pack = readPackFromDir(resolved.packDir, {
      packId,
      indexEntry: resolved.entry,
      loaderFiles: loaderFiles(),
      pluginVersion: pluginVersionOf(),
    });
    return {
      pack,
      source: {
        type: 'local', localPath: fromRoot, packId, path: resolved.entry.path,
      },
    };
  }
  const repo = ledgerRepoOf(record);
  const allowFile = allowLocalRepo();
  const cacheRoot = stackCacheRoot();
  const info = ensureRepo({
    url: repo, cacheRoot, offline, allowFile,
  });
  const ref = String(refOverride || record.ref || 'main');
  // 完整 SHA 不能走 refspec 刷新；直接解析/抓取该对象。
  if (!offline && !SHA40_RE.test(ref)) refreshRef({ repoGit: info.repoGit, ref });
  const commit = resolveCommit({ repoGit: info.repoGit, ref, offline });
  fetchCommit({
    repoGit: info.repoGit, commit, ref, offline,
  });
  const index = remoteIndex(info.repoGit, commit, offline);
  const entry = remoteEntry(index, packId);
  const snap = materializeSnapshot({
    repoGit: info.repoGit,
    commit,
    packId,
    packPath: entry.path,
    indexEntry: entry,
    cacheRoot,
    offline,
    loaderFiles: loaderFiles(),
    pluginVersion: pluginVersionOf(),
  });
  return {
    pack: snap.pack,
    source: {
      type: 'git', repo, packId, path: entry.path, ref, commit,
    },
  };
}

function shortSource(source) {
  return source.type === 'git' ? source.commit.slice(0, 8) : 'local';
}

function pruneEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name));
  }
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理空目录失败不影响已提交的账本与 lock。
  }
}

/** purge 只允许账本内、目标栈目录下的相对路径；账本被手改时 fail closed。 */
function ledgerStackFileAbs(root, installedAs, rel) {
  const prefix = `.claude/hub/stacks/${installedAs}/`;
  const value = String(rel ?? '');
  const segments = value.split('/');
  if (!value.startsWith(prefix)
    || value.includes('\\') || value.includes(':') || /[\0\r\n]/.test(value)
    || segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StackPackError('安装账本包含非法文件路径', 'STACK_LEDGER');
  }
  return join(root, ...segments);
}


function lintPath(path) {
  if (existsSync(join(path, 'index.json'))) {
    const index = readIndex(path);
    for (const packId of Object.keys(index.packs)) {
      const { entry, packDir } = resolveIndexPack(index, packId, path);
      const pack = readPackFromDir(packDir, {
        packId,
        indexEntry: entry,
        loaderFiles: loaderFiles(),
        pluginVersion: pluginVersionOf(),
      });
      log('ok', `${packId}@${pack.manifest.version}（${pack.files.length} 个文件）`);
      for (const warning of pack.warnings) log('warn', `${packId}：${warning}`);
    }
    return;
  }
  const pack = readPackFromDir(path, {
    loaderFiles: loaderFiles(),
    pluginVersion: pluginVersionOf(),
  });
  log('ok', `${pack.id}@${pack.manifest.version}（${pack.files.length} 个文件）`);
  for (const warning of pack.warnings) log('warn', `${pack.id}：${warning}`);
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, [
    '--root', '--repo', '--ref', '--as', '--from', '--offline', '--dry-run', '--force',
    '--no-gen', '--keep', '--purge', '--json', '--all', '--keep-days', '--apply',
  ]);
  const [command, packId] = positionals(argv);
  if (!command) throw new Error('用法：devflow stack <add|list|update|restore|remove|status|lock|lint|cache>');
  const root = projectRoot(argValue(argv, '--root', process.cwd()));

  if (command === 'lint') {
    const path = resolve(packId || '.');
    lintPath(path);
    return { linted: path };
  }

  // cache 是用户级维护命令：不依赖当前目录的 hub.yaml，必须在 loadHub 之前处理。
  if (command === 'cache') {
    const [, sub] = positionals(argv);
    if (sub !== 'gc') throw new Error('未知 cache 子命令');
    // 显式取值：`--keep-days -1` 不能被 argValue 当成缺值而回退到默认 30。
    const keepDays = Number(optionValue(argv, '--keep-days', '30'));
    if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error('--keep-days 必须是正整数');
    const cacheRoot = stackCacheRoot();
    const cutoff = Date.now() - keepDays * 86400000;
    const stale = listSnapshots(cacheRoot).filter((item) => item.mtimeMs < cutoff);
    const apply = hasFlag(argv, '--apply');
    if (!stale.length) log('ok', `没有超过 ${keepDays} 天的快照`);
    for (const item of stale) {
      log('info', `${apply ? '删除' : '将删除'} ${item.packId}@${item.commit.slice(0, 8)}`);
    }
    if (apply) {
      for (const item of stale) {
        rmSync(item.snapshotDir, { recursive: true, force: true });
        rmSync(item.metaFile, { force: true });
      }
      log('ok', `已删除 ${stale.length} 个过期快照；其他项目可能需要重新联网拉取`);
    } else if (stale.length) {
      log('info', 'dry-run：加 --apply 才会删除；其他项目可能需要重新联网拉取');
    }
    return { stale: stale.length };
  }

  loadHub(root);

  if (command === 'add') {
    // 本地目录没有 ref，也不存在离线缓存语义；--offline 只对远程来源有意义。
    // 显式 --from 优先于环境变量默认值；只有两者都显式给出才算互斥。
    const from = argValue(argv, '--from', null);
    const repoArg = argValue(argv, '--repo', null);
    const offline = hasFlag(argv, '--offline');
    if (repoArg && from) throw new Error('--repo 与 --from 互斥');
    if (from && hasOption(argv, '--ref')) throw new Error('--from 与 --ref 互斥');
    if (from && offline) throw new Error('--from 与 --offline 互斥');
    const repo = from ? null : (repoArg || process.env.DEVFLOW_STACK_REPO || null);
    if (offline && !repo) throw new Error('--offline 只能与远程来源搭配');
    if (!packId) throw new Error('缺少包名：devflow stack add <packId> [--repo <url>|--from <dir>]');
    if (!from && !repo) {
      throw new Error('add 必须提供 --from、--repo 或 DEVFLOW_STACK_REPO 之一，例如：devflow stack add java-spring --from ../devflow-stacks');
    }

    let pack;
    let source;
    if (from) {
      const fromRoot = resolve(from);
      const index = readIndex(fromRoot);
      const resolved = resolveIndexPack(index, packId, fromRoot);
      pack = readPackFromDir(resolved.packDir, {
        packId,
        indexEntry: resolved.entry,
        loaderFiles: loaderFiles(),
        pluginVersion: pluginVersionOf(),
      });
      source = {
        type: 'local', localPath: fromRoot, packId, path: resolved.entry.path,
      };
    } else {
      // 归一化后的 URL 才进入账本与 lock；原始值可能含 userinfo。
      const allowFile = allowLocalRepo();
      const normalizedRepo = normalizeRepoUrl(repo, { allowFile });
      const cacheRoot = stackCacheRoot();
      const info = ensureRepo({
        url: normalizedRepo, cacheRoot, offline, allowFile,
      });
      const ref = argValue(argv, '--ref', 'main');
      if (!offline) refreshRef({ repoGit: info.repoGit, ref });
      const commit = resolveCommit({ repoGit: info.repoGit, ref, offline });
      fetchCommit({
        repoGit: info.repoGit, commit, ref, offline,
      });
      const index = remoteIndex(info.repoGit, commit, offline);
      const entry = remoteEntry(index, packId);
      const snapshot = materializeSnapshot({
        repoGit: info.repoGit,
        commit,
        packId,
        packPath: entry.path,
        indexEntry: entry,
        cacheRoot,
        offline,
        loaderFiles: loaderFiles(),
        pluginVersion: pluginVersionOf(),
      });
      pack = snapshot.pack;
      source = {
        type: 'git', repo: normalizedRepo, packId, path: entry.path, ref, commit,
      };
    }

    const installedAs = argValue(argv, '--as', packId);
    if (!isValidStackName(installedAs)) {
      throw new Error('--as 不是合法的栈名：只允许 [a-z0-9][a-z0-9_-]*');
    }
    for (const warning of pack.warnings) log('warn', `${packId}：${warning}`);
    if (hasFlag(argv, '--dry-run')) {
      log('info', `将安装 ${packId}@${pack.manifest.version} → .claude/hub/stacks/${installedAs}`);
      return { dryRun: true, packId, installedAs };
    }
    const noGen = hasFlag(argv, '--no-gen');
    const result = applyInstall({
      root,
      installedAs,
      pack,
      source,
      sources: readSources(root),
      force: hasFlag(argv, '--force'),
      noGen,
      generate: noGen ? null : runGen,
      onWarn: (message) => log('warn', message),
    });
    log('ok', `已安装 ${packId}@${pack.manifest.version} → .claude/hub/stacks/${installedAs}（${result.action}）`);
    if (!noGen && !declaredStacks(root).has(installedAs)) {
      log('info', `hub.yaml 尚未声明 ${installedAs}；补充 stack: ${installedAs}（或对应子项目的 stack）后再运行 node scripts/devflow-gen.mjs`);
    }
    return result;
  }

  if (command === 'list') {
    const sources = readSources(root);
    const repoArg = argValue(argv, '--repo', null);
    const installed = Object.values(sources.packs).map((record) => ({
      installedAs: record.installedAs,
      version: record.version,
      commit: record.commit || null,
      source: record.source,
      repo: record.repo || record.localPath,
    }));
    const available = [];
    if (repoArg) {
      const allowFile = allowLocalRepo();
      const normalizedRepo = normalizeRepoUrl(repoArg, { allowFile });
      const cacheRoot = stackCacheRoot();
      const info = ensureRepo({ url: normalizedRepo, cacheRoot, allowFile });
      const ref = argValue(argv, '--ref', 'main');
      refreshRef({ repoGit: info.repoGit, ref });
      const commit = resolveCommit({ repoGit: info.repoGit, ref });
      const index = remoteIndex(info.repoGit, commit);
      for (const [id, item] of Object.entries(index.packs)) {
        available.push({ packId: id, title: item.title || id, path: item.path });
      }
    }
    // JSON 分支之前不能写 stdout；log() 会污染机器可读输出。
    if (hasFlag(argv, '--json')) {
      console.log(JSON.stringify({ installed, available }, null, 2));
    } else {
      for (const item of installed) {
        log('ok', `${item.installedAs}@${item.version}${item.commit ? ` ${item.commit.slice(0, 8)}` : ' local'}`);
      }
      for (const item of available) log('info', `可用 ${item.packId}：${plainTitle(item.title)}`);
    }
    return { installed, available };
  }

  if (command === 'status') {
    const sources = readSources(root);
    const rows = Object.values(sources.packs).map((record) => {
      const modified = [];
      const missing = [];
      for (const [rel, hashes] of Object.entries(record.files || {})) {
        // 安装时本地就缺失的文件记 local: null，必须继续按缺失报告。
        if (hashes.local === null) {
          missing.push(rel);
          continue;
        }
        const abs = join(root, ...rel.split('/'));
        if (!existsSync(abs)) missing.push(rel);
        else if (contentHash(readFileSync(abs, 'utf8')) !== hashes.local) modified.push(rel);
      }
      return {
        installedAs: record.installedAs,
        version: record.version,
        commit: record.commit || null,
        source: record.source,
        modified: modified.length > 0,
        missing,
        modifiedFiles: modified,
      };
    });
    if (hasFlag(argv, '--json')) console.log(JSON.stringify(rows, null, 2));
    else {
      for (const row of rows) {
        const state = row.modified ? '（已手改）' : '';
        const gap = row.missing.length ? `（缺失 ${row.missing.length}）` : '';
        log(row.modified || row.missing.length ? 'warn' : 'ok',
          `${row.installedAs}@${row.version}${row.commit ? ` ${row.commit.slice(0, 8)}` : ' local'}${state}${gap}`);
      }
    }
    return { rows };
  }

  if (command === 'lock') {
    const sources = readSources(root);
    // 不新建对象：readLock 把未知顶层字段原文挂在非枚举 Symbol 上，原地替换才能保留。
    const next = readLock(root);
    next.version = 1;
    next.packs = {};
    for (const record of Object.values(sources.packs)) {
      if (record.source !== 'git') {
        log('warn', `跳过本地来源 ${record.installedAs}：不可跨机器复现`);
        continue;
      }
      // 账本可能被手工改过；lock 是可提交事实，写前再次拒绝带凭据或非法形态的 URL。
      let repo;
      try {
        repo = normalizeRepoUrl(record.repo, { allowFile: allowLocalRepo() });
      } catch {
        throw new StackPackError('栈记录中的仓库地址非法', 'STACK_URL');
      }
      next.packs[record.installedAs] = {
        installedAs: record.installedAs,
        repo,
        packId: record.packId,
        path: record.path,
        ref: record.ref,
        commit: record.commit,
        version: record.version,
      };
    }
    if (hasFlag(argv, '--dry-run')) {
      log('info', `将写入 ${Object.keys(next.packs).length} 个 lock 条目`);
    } else {
      writeLock(root, next);
      log('ok', `已写入 .claude/hub/stack-lock.yaml（${Object.keys(next.packs).length} 个包）`);
    }
    return { packs: next.packs };
  }

  if (command === 'update') {
    const all = hasFlag(argv, '--all');
    if (all && packId) throw new Error('--all 与 <installedAs> 不能同时使用');
    if (!all && !packId) throw new Error('update 需要 <installedAs> 或 --all');
    const sources = readSources(root);
    const paths = stackPaths(root);
    const names = all ? Object.keys(sources.packs) : [packId];
    if (!names.length) log('info', '没有已安装的包可更新');
    // 设计 §7：lock 缺失不阻断更新；提示可用 stack lock 重建可复现事实。
    if (!existsSync(paths.lock) && Object.values(sources.packs).some((record) => record.source === 'git')) {
      log('info', 'stack-lock.yaml 不存在；可运行 devflow stack lock 重建可复现 lock');
    }
    const refOverride = argValue(argv, '--ref', null);
    const offline = hasFlag(argv, '--offline');
    const dryRun = hasFlag(argv, '--dry-run');
    const force = hasFlag(argv, '--force');
    const noGen = hasFlag(argv, '--no-gen');
    let changed = 0;
    for (const name of names) {
      if (!isValidStackName(name)) {
        throw new Error('栈名不合法：只允许 [a-z0-9][a-z0-9_-]*');
      }
      const record = sources.packs[name];
      if (!record) throw new Error(`未安装：${name}`);
      const { pack, source } = loadRecordSource(record, refOverride, offline);
      for (const warning of pack.warnings) log('warn', `${record.packId}：${warning}`);
      if (dryRun) {
        // 设计第 9 节：dry-run 输出每个文件的动作，不落盘。
        if (!existsSync(paths.stackDir(name))) {
          throw new Error('目标目录缺失，不能执行更新；请先运行 devflow stack restore 或重新 add');
        }
        const labels = {
          write: '写入', delete: '删除', keep: '保留', missing: '本地缺失',
          conflict: '冲突', orphan: '额外文件', same: '不变',
        };
        const plan = planPackUpdate({ root, installedAs: name, pack });
        for (const op of plan.ops) {
          log('info', `${name} ${op.merged ? '合并写入' : labels[op.type] || op.type} ${op.rel}`);
        }
        for (const warning of plan.warnings) log('warn', warning);
        log('info', `将更新 ${name} → ${shortSource(source)}`);
        continue;
      }
      applyPackUpdate({
        root,
        installedAs: name,
        pack,
        source,
        force,
        noGen,
        generate: noGen ? null : runGen,
        onWarn: (message) => log('warn', message),
      });
      log('ok', `已更新 ${name} → ${shortSource(source)}`);
      changed += 1;
    }
    if (!dryRun && changed && noGen) log('info', '--no-gen：跳过 gen；运行 node scripts/devflow-gen.mjs 刷新投影');
    return { updated: dryRun ? [] : names };
  }

  if (command === 'restore') {
    const lock = readLock(root);
    if (!Object.keys(lock.packs).length) {
      log('info', '没有可恢复的包：stack-lock.yaml 为空或不存在');
      return { restored: [] };
    }
    const offline = hasFlag(argv, '--offline');
    const force = hasFlag(argv, '--force');
    const dryRun = hasFlag(argv, '--dry-run');
    const noGen = hasFlag(argv, '--no-gen');
    const allowFile = allowLocalRepo();
    const cacheRoot = stackCacheRoot();
    const modes = {
      restore: '恢复', adopt: '采纳一致目录', force: '强制覆盖', modified: '保留本地并标记 modified',
    };
    let changed = 0;
    let needsGen = false;
    for (const [installedAs, entry] of Object.entries(lock.packs)) {
      // lock 里的 repo 与 packId 都必须先校验，非法值不进入路径与日志。
      let repo;
      try {
        repo = normalizeRepoUrl(entry.repo, { allowFile });
      } catch {
        throw new StackPackError('stack-lock.yaml 中的仓库地址缺失或非法', 'STACK_LOCK');
      }
      const packId = lockPackIdOf(entry);
      const info = ensureRepo({
        url: repo, cacheRoot, offline, allowFile,
      });
      // restore 只使用 lock 的 commit，不跟随分支移动。
      fetchCommit({
        repoGit: info.repoGit, commit: entry.commit, ref: entry.ref, offline,
      });
      // lock 的 path 不能被篡改：以 commit 内的 index.json 为准并逐字比对。
      const index = remoteIndex(info.repoGit, entry.commit, offline);
      const indexEntry = remoteEntry(index, packId);
      if (indexEntry.path !== entry.path) {
        throw new StackPackError('stack-lock.yaml 与 index.json 的包路径不一致', 'STACK_LOCK');
      }
      const snap = materializeSnapshot({
        repoGit: info.repoGit,
        commit: entry.commit,
        packId,
        packPath: indexEntry.path,
        indexEntry,
        cacheRoot,
        offline,
        loaderFiles: loaderFiles(),
        pluginVersion: pluginVersionOf(),
      });
      const source = {
        type: 'git',
        repo,
        packId,
        path: indexEntry.path,
        ref: entry.ref,
        commit: entry.commit,
      };
      const state = targetSnapshot(root, installedAs, snap.pack);
      // 目录已存在时不能静默换 owner：账本有记录且来源不同必须先 remove。
      if (state.exists) assertRestoreOwner(root, installedAs, repo, packId);
      const mode = !state.exists ? 'restore' : (state.matches ? 'adopt' : (force ? 'force' : 'modified'));
      if (dryRun) {
        log('info', `将处理 ${installedAs}：${modes[mode]}`);
        continue;
      }
      if (mode === 'restore' || mode === 'force') {
        applyInstall({
          root,
          installedAs,
          pack: snap.pack,
          source,
          sources: readSources(root),
          force: mode === 'force',
          noGen,
          generate: noGen ? null : runGen,
          onWarn: (message) => log('warn', message),
        });
        log('ok', mode === 'force'
          ? `已强制恢复 ${installedAs}@${entry.version}`
          : `已恢复 ${installedAs}@${entry.version}`);
      } else if (mode === 'adopt') {
        adoptExisting({
          root, installedAs, pack: snap.pack, source, onWarn: (message) => log('warn', message),
        });
        log('ok', `已采纳一致目录 ${installedAs}`);
        needsGen = true;
      } else {
        // 保留本地内容，只把 lock 的包内容记为 bases 并更新账本。
        adoptExisting({
          root, installedAs, pack: snap.pack, source, allowMissing: true,
          onWarn: (message) => log('warn', message),
        });
        log('warn', `${installedAs} 与 stack-lock.yaml 内容不同：保留本地并标记 modified；确认覆盖请加 --force`);
        needsGen = true;
      }
      changed += 1;
    }
    // adopt/modified 不走 applyInstall，循环结束后统一补一次 gen。
    if (!dryRun && needsGen && !noGen) runGen(root);
    const localOnly = Object.keys(readSources(root).packs).filter((name) => !lock.packs[name]);
    if (localOnly.length) {
      log('warn', `${localOnly.join('、')} 未在 stack-lock.yaml 中，保留不删除；不能跨机器恢复，运行 devflow stack lock 或重新 add`);
    }
    if (!dryRun && changed && noGen) log('info', '--no-gen：跳过 gen；运行 node scripts/devflow-gen.mjs 刷新投影');
    return { restored: dryRun ? [] : Object.keys(lock.packs) };
  }

  if (command === 'remove') {
    const installedAs = packId;
    if (!installedAs) throw new Error('remove 需要 <installedAs>');
    if (!isValidStackName(installedAs)) {
      throw new Error('栈名不合法：只允许 [a-z0-9][a-z0-9_-]*');
    }
    // 设计第 11 节：删除不接受 --force，避免绕过引用检查制造 gen 必然报错的状态。
    if (hasFlag(argv, '--force')) {
      throw new Error('remove 不接受 --force；被引用时请先解除 hub.yaml 声明，或使用 --keep 保留目录');
    }
    const keep = hasFlag(argv, '--keep');
    const purge = hasFlag(argv, '--purge');
    if (keep && purge) throw new Error('--keep 与 --purge 不能同时使用');
    if (!keep && declaredStacks(root).has(installedAs)) {
      throw new Error(`${installedAs} 仍被 hub.yaml 引用；先手工解除声明，或使用 --keep`);
    }
    const sources = readSources(root);
    if (!sources.packs[installedAs]) throw new Error(`未安装：${installedAs}`);
    const paths = stackPaths(root);
    const target = paths.stackDir(installedAs);
    const bases = paths.basesDir(installedAs);
    const dryRun = hasFlag(argv, '--dry-run');
    const noGen = hasFlag(argv, '--no-gen');
    if (dryRun) {
      const mode = keep ? '（保留目录）'
        : purge ? '（只删除未改文件，保留手改与额外文件）' : '（目录与 bases 移入 trash）';
      log('info', `将移除 ${installedAs}${mode}`);
      return { removed: installedAs, keep };
    }

    // lock 必须在任何写入之前读取：损坏时 fail closed，不能留下半删除状态。
    const hasLock = existsSync(paths.lock);
    const lock = hasLock ? readLock(root) : null;

    // 删除与安装共用安装锁；账本写入是提交点，此前失败按逆序从 trash 恢复。
    const trash = join(paths.trashRoot, `${process.pid}-${Date.now()}`);
    const moved = [];
    const move = (from, to) => {
      if (!existsSync(from)) return;
      ensureDir(dirname(to));
      renameSync(from, to);
      moved.push({ from, to });
    };
    const rollbackRemoval = () => {
      const errors = [];
      for (let i = moved.length - 1; i >= 0; i -= 1) {
        const { from, to } = moved[i];
        try {
          ensureDir(dirname(from));
          renameSync(to, from);
        } catch (err) {
          errors.push(err.message);
        }
      }
      if (errors.length) {
        log('warn', `回滚未能完全恢复：${errors.join('；')}；备份保留在 .claude/.stack-trash`);
        return;
      }
      try {
        rmSync(trash, { recursive: true, force: true });
      } catch {
        // 回滚成功但清理失败只影响临时目录。
      }
    };

    withFileLock(join(paths.stagingRoot, 'install'), () => {
      try {
        // 锁内重读账本，避免用取锁前的快照误删并发更新过的文件。
        const latest = readSources(root);
        const latestRecord = latest.packs[installedAs];
        if (!latestRecord) throw new Error(`未安装：${installedAs}`);
        if (!keep) {
          if (purge) {
            const prefix = `.claude/hub/stacks/${installedAs}/`;
            for (const [rel, hashes] of Object.entries(latestRecord.files || {})) {
              if (!hashes || hashes.local === null || hashes.local !== hashes.base) continue;
              const abs = ledgerStackFileAbs(root, installedAs, rel);
              if (!existsSync(abs)) continue;
              // 取锁后、rename 前再次复核内容哈希：期间被手改的文件必须保留。
              let current;
              try {
                current = contentHash(readFileSync(abs, 'utf8'));
              } catch {
                continue;
              }
              if (current !== hashes.local) continue;
              // 保留相对路径，便于失败回滚与手工取证。
              const relInStack = rel.slice(prefix.length);
              move(abs, join(trash, installedAs, ...relInStack.split('/')));
            }
          } else {
            move(target, join(trash, installedAs));
          }
        }
        move(bases, join(trash, `${installedAs}-bases`));
        const next = { ...latest, packs: { ...latest.packs } };
        delete next.packs[installedAs];
        writeSources(root, next);
      } catch (err) {
        rollbackRemoval();
        throw err;
      }
      // 账本提交后再清理空目录；只删空目录，失败不影响一致性。
      if (purge) pruneEmptyDirs(target);
    }, { failClosed: true, timeoutMs: 10000 });

    // 只有 lock 原本存在时才回写；lock 写失败不回滚已提交的删除。
    if (hasLock && lock.packs[installedAs]) {
      delete lock.packs[installedAs];
      try {
        writeLock(root, lock);
      } catch (err) {
        log('warn', `删除已完成，但写入 stack-lock.yaml 失败：${err.message}；运行 devflow stack lock 重建`);
      }
    }

    try {
      rmSync(trash, { recursive: true, force: true });
    } catch {
      log('warn', '删除已完成，但清理临时备份失败；可手动删除 .claude/.stack-trash');
    }

    if (!noGen) runGen(root);
    log('ok', `已移除 ${installedAs}${keep ? '（保留目录）' : ''}`);
    if (keep) log('info', `${installedAs} 已成为普通栈目录，不再受 pack 更新；后续 sync 可能接管`);
    return { removed: installedAs, keep };
  }

  throw new Error(`暂不支持的子命令：${command}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
