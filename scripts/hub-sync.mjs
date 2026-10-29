#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  argValue, hasFlag, projectRoot, findPluginRoot, pluginInfo, loadHub,
  readText, writeAtomic, sha256, log, posix, isMain, ensureDir, walk, relPosix,
  readMeta,
} from './lib/common.mjs';
import { main as generate } from './gen-claude-skills.mjs';

const STAGE_PREFIX = '.claude/hub/stages/';

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('.', '').slice(0, 15);
}

function label(type) {
  return ({
    add: '新增',
    update: '更新',
    overwrite: '覆盖（已备份）',
    conflict: '冲突',
  })[type] || type;
}

function templateFiles(pluginRoot) {
  const base = join(pluginRoot, 'templates', 'stages');
  if (!existsSync(base)) return [];
  return walk(base)
    .map((abs) => relPosix(base, abs))
    .filter((rel) => rel.split('/').pop() !== '_feedback-log.md')
    .sort();
}

function readSources(root) {
  const file = join(root, '.claude', '.hub-sources.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const root = projectRoot(argValue(argv, '--root', process.cwd()));
  const dryRun = hasFlag(argv, '--dry-run');
  const force = hasFlag(argv, '--force');
  const noGen = hasFlag(argv, '--no-gen');

  loadHub(root);
  // 同步读的是“当前安装的插件版本”，不是回灌源码仓库；否则会把未发布的模板拉进项目。
  const pluginRoot = argValue(argv, '--plugin-root', null) || findPluginRoot(root);
  const info = pluginInfo(pluginRoot);
  const sources = readSources(root);
  if (!sources) {
    log('warn', '缺少 .claude/.hub-sources.json：已有文件一律按“可能手改”处理，冲突时需 --force 才会覆盖。');
  }

  const files = templateFiles(pluginRoot);
  if (!files.length) throw new Error(`插件里没有阶段模板：${posix(join(pluginRoot, 'templates', 'stages'))}`);

  const actions = [];
  for (const rel of files) {
    const src = join(pluginRoot, 'templates', 'stages', ...rel.split('/'));
    const destRel = `${STAGE_PREFIX}${rel}`;
    const dest = join(root, ...destRel.split('/'));
    const templateHash = sha256(readText(src));
    if (!existsSync(dest)) {
      actions.push({ rel: destRel, type: 'add', src, dest, templateHash });
      continue;
    }
    const currentHash = sha256(readText(dest));
    if (currentHash === templateHash) {
      actions.push({ rel: destRel, type: 'same', dest, templateHash });
      continue;
    }
    const recorded = sources?.files?.[destRel];
    if (recorded && recorded === currentHash) {
      actions.push({ rel: destRel, type: 'update', src, dest, templateHash });
    } else if (force) {
      actions.push({ rel: destRel, type: 'overwrite', src, dest, templateHash });
    } else {
      actions.push({ rel: destRel, type: 'conflict', dest, templateHash });
    }
  }

  const removed = Object.keys(sources?.files || {})
    .filter((rel) => rel.startsWith(STAGE_PREFIX))
    .map((rel) => rel.slice(STAGE_PREFIX.length))
    .filter((rel) => !files.includes(rel));

  const counts = { add: 0, update: 0, overwrite: 0, conflict: 0, same: 0 };
  for (const a of actions) counts[a.type] += 1;

  if (dryRun) {
    for (const a of actions) {
      if (a.type !== 'same') log(a.type === 'conflict' ? 'warn' : '..', `${label(a.type)} ${a.rel}`);
    }
    for (const rel of removed) log('..', `模板已移除，本地保留 ${STAGE_PREFIX}${rel}`);
    console.log(`\n[dry-run] 新增 ${counts.add}，更新 ${counts.update}，覆盖 ${counts.overwrite}，冲突 ${counts.conflict}，一致 ${counts.same}。`);
    if (counts.conflict) console.log('冲突文件不会被改动；确认覆盖时加 --force，会先生成 .bak 备份。');
    return { ...counts, dryRun: true };
  }

  const backupStamp = stamp();
  const meta = readMeta(root);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pluginVersion: info.version,
    files: { ...(sources?.files || {}) },
  };
  for (const rel of Object.keys(manifest.files)) {
    if (rel.startsWith(STAGE_PREFIX) && !files.includes(rel.slice(STAGE_PREFIX.length))) {
      delete manifest.files[rel];
    }
  }

  for (const a of actions) {
    if (a.type === 'same') {
      manifest.files[a.rel] = a.templateHash;
      continue;
    }
    if (a.type === 'conflict') {
      log('warn', `跳过冲突 ${a.rel}（本地改动未记录在账本中）`);
      continue;
    }
    ensureDir(dirname(a.dest));
    if (a.type === 'overwrite') {
      const backup = `${a.dest}.bak-${backupStamp}`;
      copyFileSync(a.dest, backup);
      log('ok', `已备份 ${posix(backup)}`);
    }
    copyFileSync(a.src, a.dest);
    manifest.files[a.rel] = a.templateHash;
    log('ok', `${label(a.type)} ${a.rel}`);
  }

  writeAtomic(join(root, '.claude', '.hub-sources.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (meta) {
    writeAtomic(join(root, '.devflow.json'), `${JSON.stringify({
      ...meta,
      pluginVersion: info.version,
    }, null, 2)}\n`);
  }

  if (!noGen) await generate(['--root', root]);

  console.log(`\n完成：新增 ${counts.add}，更新 ${counts.update}，覆盖 ${counts.overwrite}，冲突 ${counts.conflict}，一致 ${counts.same}。`);
  if (counts.conflict) console.log('冲突文件保留本地版本；确认覆盖时加 --force。');
  return { ...counts, applied: true };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
