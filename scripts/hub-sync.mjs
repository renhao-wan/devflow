#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  argValue, hasFlag, projectRoot, findPluginRoot, pluginInfo, loadHub, satisfies,
  readText, writeAtomic, sha256, contentHash, log, posix, isMain, ensureDir, walk, relPosix,
  readMeta, isGeneratedArtifact, isRealPathInside,
} from './lib/common.mjs';
import { mergeTexts } from './lib/upstream.mjs';
import { main as generate } from './gen-claude-skills.mjs';

const HUB_PREFIX = '.claude/hub/';

const TEMPLATE_ROOTS = [
  { sub: 'stages', src: 'templates/stages' },
  { sub: '_shared', src: 'templates/shared' },
];

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('.', '').slice(0, 15);
}

function label(type) {
  return ({
    add: '新增',
    update: '更新',
    merged: '自动合并',
    overwrite: '覆盖（已备份）',
    conflict: '冲突',
    keep: '保留手改',
  })[type] || type;
}

function templateFiles(pluginRoot) {
  const out = [];
  for (const def of TEMPLATE_ROOTS) {
    const base = join(pluginRoot, ...def.src.split('/'));
    if (!existsSync(base)) continue;
    for (const abs of walk(base)) {
      const rel = relPosix(base, abs);
      if (isGeneratedArtifact(rel) || rel.split('/').pop() === '_feedback-log.md') continue;
      out.push({ hubRel: `${def.sub}/${rel}`, destRel: `${HUB_PREFIX}${def.sub}/${rel}`, src: abs });
    }
  }
  return out.sort((a, b) => a.hubRel.localeCompare(b.hubRel));
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

function recordOf(sources, rel) {
  const raw = sources?.files?.[rel];
  if (!raw) return null;
  if (typeof raw === 'string') return { base: raw, local: raw, legacy: true };
  if (typeof raw === 'object' && raw.base && raw.local) return { base: raw.base, local: raw.local };
  return null;
}

function baseSnapshotPath(root, hubRel) {
  return join(root, '.claude', '.hub-bases', ...hubRel.split('/'));
}

function localHashMatches(record, destText, currentHash) {
  if (!record) return false;
  if (record.local === currentHash) return true;
  // 旧账本记录的是原始文本 sha256；兼容 CRLF 文件，避免升级后误判成手改。
  return record.legacy && record.local === sha256(destText);
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
  const requires = hub.config.requiresPlugin || '*';
  if (!satisfies(info.version, requires)) {
    throw new Error(`插件版本 ${info.version} 不满足 hub.yaml 的 requiresPlugin ${requires}。请先升级插件。`);
  }
  const sources = readSources(root);
  if (!sources) {
    log('warn', '缺少 .claude/.hub-sources.json：已有文件一律按“可能手改”处理，冲突时需 --force 才会覆盖。');
  }

  const files = templateFiles(pluginRoot);
  if (!files.length) throw new Error(`插件里没有阶段或共享模板：${posix(join(pluginRoot, 'templates'))}`);

  const actions = [];
  for (const file of files) {
    const templateText = readText(file.src);
    const templateHash = contentHash(templateText);
    const dest = join(root, ...file.destRel.split('/'));
    const record = recordOf(sources, file.destRel);

    if (!existsSync(dest)) {
      actions.push({ ...file, dest, type: 'add', templateText, templateHash });
      continue;
    }

    const destText = readText(dest);
    const currentHash = contentHash(destText);
    if (currentHash === templateHash) {
      actions.push({ ...file, dest, type: 'same', templateText, templateHash });
      continue;
    }

    const localClean = localHashMatches(record, destText, currentHash);
    if (localClean) {
      actions.push({ ...file, dest, type: 'update', templateText, templateHash });
      continue;
    }

    const templateUnchanged = record && record.base === templateHash;
    if (templateUnchanged) {
      actions.push({ ...file, dest, type: 'keep', templateText, templateHash });
      continue;
    }

    // --force 是用户明确的覆盖意图，优先于自动三方合并。
    if (force) {
      actions.push({ ...file, dest, type: 'overwrite', templateText, templateHash });
      continue;
    }

    if (record && !record.legacy) {
      const baseFile = baseSnapshotPath(root, file.hubRel);
      if (existsSync(baseFile)) {
        const merged = mergeTexts(readText(baseFile), destText, templateText);
        if (merged.ok) {
          actions.push({ ...file, dest, type: 'merged', templateText, templateHash, mergedText: merged.content });
          continue;
        }
        if (merged.conflicts) {
          actions.push({ ...file, dest, type: 'conflict', templateText, templateHash, reason: '三方合并冲突' });
          continue;
        }
        actions.push({ ...file, dest, type: 'conflict', templateText, templateHash, reason: merged.error || 'git merge-file 失败' });
        continue;
      }
    }

    actions.push({ ...file, dest, type: 'conflict', templateText, templateHash, reason: '本地改动未记录基线' });
  }
  const known = new Set(files.map((f) => f.hubRel));
  const removed = Object.keys(sources?.files || {})
    .filter((rel) => rel.startsWith(HUB_PREFIX))
    .map((rel) => rel.slice(HUB_PREFIX.length))
    .filter((hubRel) => !known.has(hubRel) && !isGeneratedArtifact(hubRel));

  const counts = { add: 0, update: 0, merged: 0, overwrite: 0, conflict: 0, keep: 0, same: 0 };
  for (const a of actions) counts[a.type] += 1;

  for (const a of actions) {
    if (!a.dest || a.type === 'same' || a.type === 'keep') continue;
    if (!isRealPathInside(root, a.dest)) {
      throw new Error(`同步目标越界（可能被 junction/符号链接引到项目外）：${posix(a.dest)}`);
    }
  }

  if (dryRun) {
    for (const a of actions) {
      if (a.type === 'same') continue;
      const detail = a.reason ? `（${a.reason}）` : '';
      log(a.type === 'conflict' ? 'warn' : '..', `${label(a.type)} ${a.destRel}${detail}`);
    }
    for (const hubRel of removed) log('..', `模板已移除，本地保留 ${HUB_PREFIX}${hubRel}`);
    console.log(`\n[dry-run] 新增 ${counts.add}，更新 ${counts.update}，自动合并 ${counts.merged}，`
      + `覆盖 ${counts.overwrite}，冲突 ${counts.conflict}，保留手改 ${counts.keep}，一致 ${counts.same}。`);
    if (counts.conflict) console.log('冲突文件不会被改动；确认覆盖时加 --force，会先生成 .bak 备份。');
    return { ...counts, dryRun: true };
  }

  const backupStamp = stamp();
  const meta = readMeta(root);
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    pluginVersion: info.version,
    files: {},
  };
  // 保留未被模板覆盖的账本项（例如将来新增的其他来源），再清理已移除的模板项。
  for (const [rel, value] of Object.entries(sources?.files || {})) {
    if (rel.startsWith(HUB_PREFIX)) continue;
    manifest.files[rel] = value;
  }

  const sourcesFile = join(root, '.claude', '.hub-sources.json');
  const persist = () => writeAtomic(sourcesFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const writeBase = (hubRel, text) => {
    const target = baseSnapshotPath(root, hubRel);
    if (existsSync(target) && contentHash(readText(target)) === contentHash(text)) return;
    ensureDir(dirname(target));
    writeAtomic(target, text);
  };

  persist();

  for (const a of actions) {
    if (a.type === 'same') {
      writeBase(a.hubRel, a.templateText);
      manifest.files[a.destRel] = { base: a.templateHash, local: a.templateHash };
      persist();
      continue;
    }
    if (a.type === 'keep') {
      // 模板没变、本地手改：基线保持不变，只确保快照存在以便下次三方合并。
      const baseFile = baseSnapshotPath(root, a.hubRel);
      if (!existsSync(baseFile)) writeBase(a.hubRel, a.templateText);
      manifest.files[a.destRel] = {
        base: contentHash(readText(baseFile)),
        local: contentHash(readText(a.dest)),
      };
      persist();
      continue;
    }
    if (a.type === 'conflict') {
      log('warn', `跳过冲突 ${a.destRel}${a.reason ? `（${a.reason}）` : ''}`);
      continue;
    }

    if (!isRealPathInside(root, a.dest)) {
      throw new Error(`同步目标越界（可能被 junction/符号链接引到项目外）：${posix(a.dest)}`);
    }
    ensureDir(dirname(a.dest));
    if (a.type === 'overwrite') {
      const backup = `${a.dest}.bak-${backupStamp}`;
      copyFileSync(a.dest, backup);
      log('ok', `已备份 ${posix(backup)}`);
    }
    if (a.type === 'merged') {
      writeAtomic(a.dest, a.mergedText);
      log('ok', `${label(a.type)} ${a.destRel}`);
    } else {
      copyFileSync(a.src, a.dest);
      log('ok', `${label(a.type)} ${a.destRel}`);
    }
    writeBase(a.hubRel, a.templateText);
    manifest.files[a.destRel] = {
      base: a.templateHash,
      local: contentHash(readText(a.dest)),
    };
    persist();
  }

  if (counts.conflict) {
    console.log(`\n${counts.conflict} 个冲突文件已保留本地内容：手工合并后重新运行 /devflow:sync；`
      + '确认以模板覆盖时加 --force，会先生成 .bak 备份。');
  }
  if (counts.merged) {
    console.log(`${counts.merged} 个文件已自动三方合并；请检查合并结果后提交。`);
  }

  for (const hubRel of removed) log('..', `模板已移除，本地保留 ${HUB_PREFIX}${hubRel}`);

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

  console.log(`\n完成：新增 ${counts.add}，更新 ${counts.update}，自动合并 ${counts.merged}，`
    + `覆盖 ${counts.overwrite}，冲突 ${counts.conflict}，保留手改 ${counts.keep}，一致 ${counts.same}。`);
  if (counts.conflict) console.log('冲突文件保留本地版本；确认覆盖时加 --force。');
  return { ...counts, applied: true };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
