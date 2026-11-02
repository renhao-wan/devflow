#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, log, posix, isMain, projectRoot, readText, writeAtomic,
  resolveUpstreamRoot, isPluginCache, cacheGuardMessage, loadHub, pluginInfo,
  isValidStageName, normalizeEol,
} from './lib/common.mjs';
import {
  JOURNAL, resolveUnits, planUnits, applyPlan, backupFile, makeId,
  updateVersionFiles, updateChangelog, appendLog, revertFromLog,
  bumpKind, bumpVersion,
} from './lib/upstream.mjs';

function showDiff(content, target, label) {
  const tmp = join(tmpdir(), `devflow-diff-${process.pid}-${Date.now()}.txt`);
  try {
    writeAtomic(tmp, content);
    const result = spawnSync('git', ['diff', '--no-index', '--', target, tmp], { encoding: 'utf8' });
    if (result.status === 0 || result.status === 1) {
      console.log(`\n--- ${label} ---`);
      console.log(result.stdout || '（内容一致）');
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function reportText(plans) {
  let reusable = 0;
  let pending = 0;
  let local = 0;
  let unchanged = 0;
  for (const plan of plans) {
    for (const file of plan.files) {
      const rel = `${plan.unit.kind === 'shared' ? '_shared' : plan.unit.name}/${file.rel}`;
      if (file.skipped) {
        console.log(`[跳过] ${rel}（${file.reason}）`);
        continue;
      }
      const { verdict } = file;
      if (verdict.type === 'local') {
        local += 1;
        console.log(`[项目专属] ${rel}${verdict.hints.length ? `（${verdict.hints.join('、')}）` : ''}`);
        continue;
      }
      reusable += 1;
      const removed = verdict.removed.length ? `（剔除 ${verdict.removed.length} 行：${[...new Set(verdict.removed.map((r) => r.reason))].join('、')}）` : '';
      if (file.changed) {
        pending += 1;
        console.log(`[可回灌] ${rel}${removed}`);
      } else {
        unchanged += 1;
        console.log(`[无变化] ${rel}${removed}`);
      }
    }
  }
  return { reusable, pending, local, unchanged };
}

function jsonReport(plans, extra) {
  return {
    ...extra,
    units: plans.map((p) => ({ kind: p.unit.kind, name: p.unit.name })),
    files: plans.flatMap((p) => p.files.map((f) => ({
      unit: p.unit.kind === 'shared' ? '_shared' : p.unit.name,
      path: f.rel,
      type: f.skipped ? 'skipped' : f.verdict.type,
      changed: Boolean(f.changed),
      removed: f.verdict?.removed?.length || 0,
      hints: f.verdict?.hints || [],
      reason: f.reason || null,
    }))),
  };
}

function passthrough(argv, names) {
  const out = [];
  for (const name of names) {
    const value = argValue(argv, name, null);
    if (value !== null) out.push(name, value);
  }
  return out;
}

async function runRemote(argv, { root, pluginRoot, units }) {
  const { main: ship } = await import('./hub-ship.mjs');
  const args = ['--root', root, '--plugin-root', pluginRoot];
  for (const unit of units) {
    if (unit.kind === 'stage') args.push('--stage', unit.name);
  }
  if (units.some((u) => u.kind === 'shared')) args.push('--shared');
  args.push(...passthrough(argv, ['--base', '--bump', '--remote', '--resume']));
  if (hasFlag(argv, '--fork')) args.push('--fork');
  if (hasFlag(argv, '--no-pr')) args.push('--no-pr');
  // 远程回灌只有加 --apply 才真正推送；不带时等价于 ship --dry-run。
  if (!hasFlag(argv, '--apply')) args.push('--dry-run');
  return ship(args);
}

export async function main(argv = process.argv.slice(2)) {
  const root = projectRoot(argValue(argv, '--root', process.cwd()));
  const stage = argValue(argv, '--stage', null);
  const shared = hasFlag(argv, '--shared');
  const all = hasFlag(argv, '--all');
  const apply = hasFlag(argv, '--apply');
  const json = hasFlag(argv, '--json');
  const to = argValue(argv, '--to', 'local');
  const revertId = argValue(argv, '--revert', null);

  if (!['local', 'remote'].includes(to)) throw new Error(`--to 只支持 local|remote，收到：${to}`);
  const bumpArg = argValue(argv, '--bump', null);
  // 无论是否 --apply，只要显式给了 --bump 就先校验，避免预览时静默忽略非法值。
  if (bumpArg !== null) bumpKind(bumpArg);
  if (stage && !isValidStageName(stage)) {
    throw new Error(`阶段名非法：${stage}。只允许小写字母开头的 [a-z0-9_-]。`);
  }

  const pluginRoot = resolveUpstreamRoot(root, argValue(argv, '--plugin-root', null));
  const info = pluginInfo(pluginRoot);

  if (revertId) {
    if (isPluginCache(pluginRoot)) throw new Error(cacheGuardMessage(pluginRoot));
    const entry = revertFromLog(pluginRoot, revertId);
    log('ok', `已回滚回灌记录 ${revertId}（${entry.files.length} 个模板文件）`);
    return { reverted: revertId, files: entry.files };
  }

  let units;
  try {
    units = resolveUnits(root, { stage, shared, all });
  } catch (err) {
    throw err;
  }

  if (to === 'remote') {
    return runRemote(argv, { root, pluginRoot, units });
  }

  const { config } = loadHub(root);
  const cacheTarget = isPluginCache(pluginRoot);

  let plans;
  try {
    plans = planUnits(root, pluginRoot, units, config);
  } catch (err) {
    throw err;
  }

  if (!json) {
    for (const plan of plans) {
      console.log(`\n== ${plan.unit.kind === 'shared' ? '共享规则 .claude/hub/_shared' : `阶段 ${plan.unit.name}`} ==`);
      const counts = reportText([plan]);
      for (const file of plan.pending) {
        showDiff(file.verdict.content, file.targetAbs, `${plan.unit.name}/${file.rel}（插件 → 项目，已剔除敏感行）`);
      }
      console.log(
        `小结：${counts.reusable} 个可回灌（${counts.pending} 个有变化），`
        + `${counts.local} 个项目专属，${counts.unchanged} 个一致。`,
      );
    }
  }

  const totals = plans.reduce((acc, plan) => {
    for (const file of plan.files) {
      if (file.skipped) continue;
      if (file.verdict.type === 'local') acc.local += 1;
      else {
        acc.reusable += 1;
        if (file.changed) acc.pending += 1;
      }
    }
    return acc;
  }, { reusable: 0, pending: 0, local: 0 });

  const summary = jsonReport(plans, { mode: 'local', applied: false });

  if (!apply) {
    if (!json) {
      console.log(`\n预览完成：${totals.reusable} 个可回灌（${totals.pending} 个有变化），${totals.local} 个项目专属。`);
      console.log('加 --apply 才会写入插件模板；加 --to remote --apply 走分支 + PR。');
      if (cacheTarget) log('warn', `目标是安装缓存（${posix(pluginRoot)}），--apply 会被拒绝，请用 --plugin-root 指向源码仓库。`);
    }
    return json ? { ...summary, ...totals } : { ...totals, applied: false, units: summary.units };
  }

  if (cacheTarget) throw new Error(cacheGuardMessage(pluginRoot));

  const noBump = hasFlag(argv, '--no-bump');
  const kind = noBump ? null : bumpKind(bumpArg ?? 'patch');

  // 上次中断可能停在“文件已复制、版本未升级”：先记账再写入，重跑时续做。
  const journalFile = join(pluginRoot, ...JOURNAL.split('/'));
  let journal = null;
  if (existsSync(journalFile)) {
    try {
      journal = JSON.parse(readText(journalFile));
    } catch {
      throw new Error(`无法解析上次中断的回灌记录：${posix(journalFile)}。请检查或删除后重试。`);
    }
    const same = JSON.stringify(journal.units) === JSON.stringify(units.map((u) => `${u.kind}:${u.name}`));
    if (!same) {
      throw new Error(`上次未完成的回灌属于 ${journal.units.join('、')}，请先完成或删除 ${posix(journalFile)}。`);
    }
    if (info.version !== journal.oldVersion && info.version !== journal.nextVersion) {
      throw new Error(
        `插件版本 ${info.version} 与未完成回灌记录的 ${journal.oldVersion} → ${journal.nextVersion} 不一致，`
        + `请检查后删除 ${posix(journalFile)}。`,
      );
    }
    log('warn', `检测到上次未完成的回灌，继续完成 ${journal.oldVersion} → ${journal.nextVersion}`);
  } else {
    if (!totals.pending) {
      if (!json) {
        console.log(totals.reusable ? '可回灌文件与插件模板一致，未修改插件。' : '没有可回灌内容，未修改插件。');
      }
      return json ? { ...summary, ...totals, applied: false } : { ...totals, applied: false };
    }
    const oldVersion = info.version;
    const nextVersion = kind ? bumpVersion(oldVersion, kind) : oldVersion;
    journal = {
      id: makeId(),
      units: units.map((u) => `${u.kind}:${u.name}`),
      oldVersion,
      nextVersion,
      bumped: Boolean(kind),
      files: plans.flatMap((plan) => plan.pending.map((f) => `${plan.unit.targetRel}/${f.rel}`)),
      created: plans.flatMap((plan) => plan.pending
        .filter((f) => !existsSync(f.targetAbs))
        .map((f) => `${plan.unit.targetRel}/${f.rel}`)),
      createdAt: new Date().toISOString(),
    };
    writeAtomic(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  }

  const backupId = journal.id;
  for (const rel of ['.claude-plugin/plugin.json', 'package.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md']) {
    backupFile(pluginRoot, backupId, rel);
  }
  const result = applyPlan({ pending: plans.flatMap((p) => p.pending) }, pluginRoot, { backupId });
  // 中断续做时本次 pending 可能为空，历史清单仍要进入日志与回滚范围。
  const written = [...new Set([...(journal.files || []), ...result.written])];
  const created = [...new Set([...(journal.created || []), ...result.created])];

  if (journal.bumped) {
    updateVersionFiles(pluginRoot, journal.nextVersion);
    updateChangelog(pluginRoot, journal.nextVersion, units, written);
  }

  appendLog(pluginRoot, {
    id: backupId,
    at: new Date().toISOString(),
    mode: 'local',
    units: units.map((u) => (u.kind === 'shared' ? '共享规则' : `${u.name} 阶段`)),
    project: posix(root).split('/').pop(),
    files: written,
    created,
    oldVersion: journal.bumped ? journal.oldVersion : null,
    newVersion: journal.bumped ? journal.nextVersion : null,
  });

  rmSync(journalFile, { force: true });

  if (!json) {
    log('ok', `已回灌 ${written.length} 个文件${journal.bumped ? `，插件版本 ${journal.oldVersion} → ${journal.nextVersion}` : '（版本未变）'}`);
    log('ok', `回灌日志：${posix(join(pluginRoot, '.devflow', 'upstream-log.jsonl'))}`);
    log('ok', `可回滚：/devflow:upstream --revert ${backupId}`);
  }

  return json
    ? { ...summary, ...totals, applied: true, version: journal.nextVersion, id: backupId, written }
    : { ...totals, applied: true, version: journal.nextVersion, id: backupId, written };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
