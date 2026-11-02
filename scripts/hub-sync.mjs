#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  argValue, hasFlag, projectRoot, findPluginRoot, pluginInfo, loadHub, satisfies,
  readText, writeAtomic, sha256, contentHash, log, posix, isMain, ensureDir, walk, relPosix,
  readMeta, isGeneratedArtifact, isRealPathInside,
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
    .filter((rel) => rel.split('/').pop() !== '_feedback-log.md' && !isGeneratedArtifact(rel))
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

  const hub = loadHub(root);
  // 同步读的是“当前安装的插件版本”，不是回灌源码仓库；否则会把未发布的模板拉进项目。
  const pluginRoot = argValue(argv, '--plugin-root', null) || findPluginRoot(root);
  const info = pluginInfo(pluginRoot);
  // 先校验版本约束，避免模板已复制、投影却因 requiresPlugin 不满足而生成失败。
  const requires = hub.config.requiresPlugin || '*';
  if (!satisfies(info.version, requires)) {
    throw new Error(`插件版本 ${info.version} 不满足 hub.yaml 的 requiresPlugin ${requires}。请先升级插件。`);
  }
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
    const templateHash = contentHash(readText(src));
    if (!existsSync(dest)) {
      actions.push({ rel: destRel, type: 'add', src, dest, templateHash });
      continue;
    }
    const destText = readText(dest);
    const currentHash = contentHash(destText);
    if (currentHash === templateHash) {
      actions.push({ rel: destRel, type: 'same', dest, templateHash });
      continue;
    }
    const recorded = sources?.files?.[destRel];
    // 旧版账本记录的是原始文本哈希；兼容它，避免升级后把未改动的 CRLF 文件误判成手改。
    const recordedMatch = recorded && (recorded === currentHash || recorded === sha256(destText));
    if (recordedMatch) {
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
    .filter((rel) => !files.includes(rel) && !isGeneratedArtifact(rel));

  const counts = { add: 0, update: 0, overwrite: 0, conflict: 0, same: 0 };
  for (const a of actions) counts[a.type] += 1;

  // 写入前校验真实路径：目标目录可能被 junction/符号链接指向项目外。
  for (const a of actions) {
    if (!a.dest || a.type === 'same') continue;
    if (!isRealPathInside(root, a.dest)) {
      throw new Error(`同步目标越界（可能被 junction/符号链接引到项目外）：${posix(a.dest)}`);
    }
  }

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

  const sourcesFile = join(root, '.claude', '.hub-sources.json');
  const persist = () => writeAtomic(sourcesFile, `${JSON.stringify(manifest, null, 2)}\n`);
  // 先落一次账本（移除项与一致项），再逐文件更新；中途失败时账本最多落后一个已复制的文件，
  // 而该文件内容已等于模板哈希，下次同步会按“一致”自动修正。
  for (const a of actions) {
    if (a.type === 'same') manifest.files[a.rel] = a.templateHash;
  }
  persist();

  for (const a of actions) {
    if (a.type === 'same' || a.type === 'conflict') {
      if (a.type === 'conflict') log('warn', `跳过冲突 ${a.rel}（本地改动未记录在账本中）`);
      continue;
    }
    // 检查与写入之间可能被替换；写入前再确认一次。
    if (!isRealPathInside(root, a.dest)) {
      throw new Error(`同步目标越界（可能被 junction/符号链接引到项目外）：${posix(a.dest)}`);
    }
    ensureDir(dirname(a.dest));
    if (a.type === 'overwrite') {
      const backup = `${a.dest}.bak-${backupStamp}`;
      copyFileSync(a.dest, backup);
      log('ok', `已备份 ${posix(backup)}`);
    }
    copyFileSync(a.src, a.dest);
    manifest.files[a.rel] = a.templateHash;
    persist();
    log('ok', `${label(a.type)} ${a.rel}`);
  }

  for (const rel of removed) log('..', `模板已移除，本地保留 ${STAGE_PREFIX}${rel}`);

  persist();
  if (meta) {
    writeAtomic(join(root, '.devflow.json'), `${JSON.stringify({
      ...meta,
      pluginRoot,
      pluginVersion: info.version,
    }, null, 2)}\n`);
  }

  if (!noGen) {
    const report = await generate(['--root', root]);
    if (report.errors?.length) {
      log('warn', `同步完成，但生成阶段有 ${report.errors.length} 个错误，请按上方提示处理。`);
    }
  }

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
