#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  argValue, hasFlag, projectRoot, findPluginRoot, pluginInfo, loadHub, satisfies,
  readText, writeAtomic, sha256, contentHash, log, posix, isMain, ensureDir,
  readMeta, isGeneratedArtifact, isRealPathInside, isDraft,
  warnUnknownArgs,
} from './lib/common.mjs';
import { mergeTexts } from './lib/upstream.mjs';
import { resolveLibraries, collectTemplateFiles } from './lib/libraries.mjs';
import { templateIssues } from './lib/template-compat.mjs';
import { LOADERS } from './hub-init.mjs';
import { main as generate } from './gen-claude-skills.mjs';

const HUB_PREFIX = '.claude/hub/';

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
    blocked: '不兼容，已跳过',
    draft: '跳过草稿',
  })[type] || type;
}

/** 模板库草稿没有写入项目，不能和项目草稿一起说成“保留”。 */
function draftSummary(counts) {
  if (!counts.draft) return '保留草稿 0';
  if (counts.templateDraft) {
    return `跳过草稿 ${counts.draft}（其中模板库草稿 ${counts.templateDraft}）`;
  }
  return `保留项目草稿 ${counts.draft}`;
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
  if (typeof raw === 'string') return { base: raw, local: raw, legacy: true, source: 'upstream' };
  if (typeof raw === 'object' && raw.base && raw.local) {
    return { base: raw.base, local: raw.local, source: raw.source || 'upstream' };
  }
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
  warnUnknownArgs(argv, [
    '--root', '--dry-run', '--force', '--no-gen', '--plugin-root',
    '--personal-library', '--team-library',
  ]);
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

  const personalLibrary = argValue(argv, '--personal-library', null);
  const teamLibrary = argValue(argv, '--team-library', null);
  const files = collectTemplateFiles(resolveLibraries(root, hub.config, {
    pluginRoot,
    personalLibrary,
    teamLibrary,
  }));
  if (!files.length) throw new Error(`没有可用的阶段、共享或技术栈模板：${posix(join(pluginRoot, 'templates'))}`);

  const actions = [];
  const loaderFiles = new Set(Object.keys(LOADERS));
  for (const file of files) {
    const templateText = readText(file.src);
    const templateHash = contentHash(templateText);
    const dest = join(root, ...file.destRel.split('/'));
    // 模板库里的草稿不进入项目：TODO 不是规则，也不该覆盖项目自己的草稿。
    if (isDraft(templateText)) {
      actions.push({ ...file, dest, type: 'draft', draftOrigin: 'template', templateText, templateHash });
      continue;
    }
    const record = recordOf(sources, file.destRel);
    const compat = templateIssues(templateText, { loaderFiles, pluginVersion: info.version });
    const blocked = compat.length
      ? {
        ...file, dest, type: 'blocked', templateText, templateHash,
        reason: compat.map((issue) => issue.message).join('；'),
      }
      : null;

    if (!existsSync(dest)) {
      actions.push(blocked || { ...file, dest, type: 'add', templateText, templateHash });
      continue;
    }

    const destText = readText(dest);
    // 项目草稿是用户真源：--force 也不覆盖。
    if (isDraft(destText)) {
      actions.push({ ...file, dest, type: 'draft', draftOrigin: 'project', templateText, templateHash });
      continue;
    }
    const currentHash = contentHash(destText);
    if (currentHash === templateHash) {
      actions.push({ ...file, dest, type: 'same', templateText, templateHash });
      continue;
    }

    if (blocked) {
      actions.push(blocked);
      continue;
    }

    const localClean = localHashMatches(record, destText, currentHash);
    if (localClean) {
      actions.push({ ...file, dest, type: 'update', templateText, templateHash });
      continue;
    }

    // --force 是用户明确的覆盖意图，优先于“模板未变就保留”和自动三方合并。
    if (force) {
      actions.push({ ...file, dest, type: 'overwrite', templateText, templateHash });
      continue;
    }

    const templateUnchanged = record && record.base === templateHash;
    if (templateUnchanged) {
      actions.push({ ...file, dest, type: 'keep', templateText, templateHash });
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

  const counts = {
    add: 0, update: 0, merged: 0, overwrite: 0, conflict: 0, keep: 0,
    same: 0, blocked: 0, draft: 0, templateDraft: 0,
  };
  for (const a of actions) {
    counts[a.type] += 1;
    if (a.type === 'draft' && a.draftOrigin === 'template') counts.templateDraft += 1;
  }

  for (const a of actions) {
    if (!a.dest || a.type === 'same' || a.type === 'keep' || a.type === 'blocked' || a.type === 'draft') continue;
    if (!isRealPathInside(root, a.dest)) {
      throw new Error(`同步目标越界（可能被 junction/符号链接引到项目外）：${posix(a.dest)}`);
    }
  }

  if (dryRun) {
    for (const a of actions) {
      if (a.type === 'same' || a.type === 'draft') continue;
      const detail = a.reason ? `（${a.reason}）` : '';
      log(a.type === 'conflict' || a.type === 'blocked' ? 'warn' : '..', `${label(a.type)} [${a.source}] ${a.destRel}${detail}`);
    }
    for (const hubRel of removed) log('..', `模板已移除，本地保留 ${HUB_PREFIX}${hubRel}`);
    console.log(`\n[dry-run] 新增 ${counts.add}，更新 ${counts.update}，自动合并 ${counts.merged}，`
      + `覆盖 ${counts.overwrite}，冲突 ${counts.conflict}，不兼容 ${counts.blocked}，保留手改 ${counts.keep}，`
      + `${draftSummary(counts)}，一致 ${counts.same}。`);
    if (counts.conflict) console.log('冲突文件不会被改动；确认覆盖时加 --force，会先生成 .bak 备份。');
    if (counts.blocked) console.log('不兼容文件不会写入；升级插件或改用兼容的模板来源后重试。');
    return { ...counts, dryRun: true };
  }

  const backupStamp = stamp();
  const meta = readMeta(root);
  const manifest = {
    schemaVersion: 3,
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
      manifest.files[a.destRel] = { base: a.templateHash, local: a.templateHash, source: a.source };
      persist();
      continue;
    }
    if (a.type === 'keep') {
      // 模板没变、本地手改：基线保持不变，只确保快照存在以便下次三方合并。
      const baseFile = baseSnapshotPath(root, a.hubRel);
      if (!existsSync(baseFile)) writeBase(a.hubRel, a.templateText);
      // local 记录“上次同步的干净内容”，不能记手改后的哈希，
      // 否则下次会把这份手改误判成未改动而直接覆盖。
      const baseHash = contentHash(readText(baseFile));
      manifest.files[a.destRel] = { base: baseHash, local: baseHash, source: a.source };
      persist();
      continue;
    }
    if (a.type === 'blocked') {
      // 不写入、不更新基线，保留原记录；升级插件或换来源后重跑即可重新判定。
      const previous = sources?.files?.[a.destRel];
      if (previous) {
        manifest.files[a.destRel] = previous;
        persist();
      }
      log('warn', `跳过不兼容模板 ${a.destRel}${a.reason ? `（${a.reason}）` : ''}`);
      continue;
    }
    if (a.type === 'conflict') {
      // 本地内容保留，但把当前模板记为基线：用户手工合并后重跑即可被接受；
      // 模板再次更新时，仍以“上次模板 + 当前本地”做三方合并。
      // local 同样只记基线：手改内容不算“同步写入的内容”，下次仍按手改处理。
      writeBase(a.hubRel, a.templateText);
      manifest.files[a.destRel] = {
        base: a.templateHash,
        local: a.templateHash,
        source: a.source,
      };
      persist();
      log('warn', `跳过冲突 ${a.destRel}${a.reason ? `（${a.reason}）` : ''}；本地内容保留，已把当前模板记为基线`);
      continue;
    }

    if (a.type === 'draft') continue;

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
      log('ok', `${label(a.type)} [${a.source}] ${a.destRel}`);
    } else {
      copyFileSync(a.src, a.dest);
      log('ok', `${label(a.type)} [${a.source}] ${a.destRel}`);
    }
    writeBase(a.hubRel, a.templateText);
    // local 记录“上次同步写入的干净内容”，合并结果含本地改动，不算干净内容。
    // 若记录合并结果的哈希，下次模板未变时会被误判为未手改并用模板覆盖。
    manifest.files[a.destRel] = {
      base: a.templateHash,
      local: a.templateHash,
      source: a.source,
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
  if (counts.blocked) {
    console.log(`${counts.blocked} 个模板与当前插件不兼容，已跳过；升级插件或改用兼容来源后重试。`);
  }

  for (const hubRel of removed) log('..', `模板已移除，本地保留 ${HUB_PREFIX}${hubRel}`);

  persist();
  if (meta) {
    writeAtomic(join(root, '.devflow.json'), `${JSON.stringify({
      ...meta,
      pluginRoot,
      pluginVersion: info.version,
      ...(personalLibrary ? { personalLibraryPath: resolve(personalLibrary) } : {}),
      ...(teamLibrary ? { teamLibraryPath: resolve(teamLibrary) } : {}),
    }, null, 2)}\n`);
  }

  if (!noGen) {
    const report = await generate(['--root', root]);
    if (report.errors?.length) {
      log('warn', `同步完成，但生成阶段有 ${report.errors.length} 个错误，请按上方提示处理。`);
    }
  }

  console.log(`\n完成：新增 ${counts.add}，更新 ${counts.update}，自动合并 ${counts.merged}，`
    + `覆盖 ${counts.overwrite}，冲突 ${counts.conflict}，不兼容 ${counts.blocked}，保留手改 ${counts.keep}，`
    + `${draftSummary(counts)}，一致 ${counts.same}。`);
  if (counts.conflict) console.log('冲突文件保留本地版本；确认覆盖时加 --force。');
  return { ...counts, applied: true };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
