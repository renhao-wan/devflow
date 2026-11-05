#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  argValue, contentHash, hasFlag, hasOption, isMain, loadHub, log, pluginInfo, projectRoot,
  warnUnknownArgs,
} from './lib/common.mjs';
import { LOADERS } from './lib/loaders.mjs';
import { isValidStackName } from './lib/stacks.mjs';
import {
  StackPackError, normalizeRepoUrl, readIndex, readPackFromDir, resolveIndexPack, validateIndex,
} from './lib/stack-pack.mjs';
import { readLock, readSources, writeLock } from './lib/stack-ledger.mjs';
import {
  ensureRepo, fetchCommit, listSnapshots, materializeSnapshot, readFileAtCommit,
  refreshRef, resolveCommit, stackCacheRoot,
} from './lib/stack-fetch.mjs';
import { applyInstall } from './lib/stack-install.mjs';

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

  throw new Error(`暂不支持的子命令：${command}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
