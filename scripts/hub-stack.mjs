#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, hasOption, isMain, loadHub, log, pluginInfo, projectRoot, warnUnknownArgs,
} from './lib/common.mjs';
import { LOADERS } from './lib/loaders.mjs';
import { isValidStackName } from './lib/stacks.mjs';
import { readIndex, readPackFromDir, resolveIndexPack } from './lib/stack-pack.mjs';
import { readSources } from './lib/stack-ledger.mjs';
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

/** gen 失败不回滚安装：设计文档第 8 节只要求明确警告。 */
function runGen(root) {
  const script = join(pluginRootFromHere(), 'scripts', 'gen-claude-skills.mjs');
  const res = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
  if (res.status !== 0) {
    log('warn', `安装已完成，但 gen 失败：${(res.stderr || res.stdout || '').trim()}`);
    log('warn', '修正 hub.yaml 或栈声明后运行 node scripts/gen-claude-skills.mjs');
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

  loadHub(root);

  if (command === 'add') {
    // 本地目录没有 ref，也不存在离线缓存语义；--offline 只对远程来源有意义。
    const repo = argValue(argv, '--repo', process.env.DEVFLOW_STACK_REPO || null);
    const from = argValue(argv, '--from', null);
    const offline = hasFlag(argv, '--offline');
    if (repo && from) throw new Error('--repo 与 --from 互斥');
    if (from && hasOption(argv, '--ref')) throw new Error('--from 与 --ref 互斥');
    if (from && offline) throw new Error('--from 与 --offline 互斥');
    if (offline && !repo) throw new Error('--offline 只能与 --repo 搭配');
    if (!packId) throw new Error('缺少包名：devflow stack add <packId> --from <dir>');
    if (!from) {
      if (repo) {
        throw new Error('远程来源需要 bare 缓存；本阶段请先使用 --from，或完成 lib/stack-fetch.mjs 后重试');
      }
      throw new Error('add 必须提供 --from（本阶段）或 --repo，例如：devflow stack add java-spring --from ../devflow-stacks');
    }
    const fromRoot = resolve(from);
    const index = readIndex(fromRoot);
    const { entry, packDir } = resolveIndexPack(index, packId, fromRoot);
    const pack = readPackFromDir(packDir, {
      packId,
      indexEntry: entry,
      loaderFiles: loaderFiles(),
      pluginVersion: pluginVersionOf(),
    });
    const installedAs = argValue(argv, '--as', packId);
    if (!isValidStackName(installedAs)) {
      throw new Error('--as 不是合法的栈名：只允许 [a-z0-9][a-z0-9_-]*');
    }
    const source = {
      type: 'local', localPath: fromRoot, packId, path: entry.path,
    };
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

  throw new Error(`暂不支持的子命令：${command}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
