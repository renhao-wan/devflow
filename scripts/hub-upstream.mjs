#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, log, posix, isMain, projectRoot, readText, writeAtomic,
  resolveUpstreamRoot, isPluginCache, cacheGuardMessage, loadHub, pluginInfo,
  isValidStageName, normalizeEol, canonicalPath, relPosix, readMeta,
} from './lib/common.mjs';
import {
  JOURNAL, resolveUnits, planUnits, applyPlan, backupFile, makeId,
  updateVersionFiles, updateChangelog, appendLog, readLog, revertFromLog,
  bumpKind, bumpVersion,
} from './lib/upstream.mjs';
import { resolveLibraryRoot, assertLibraryRoot } from './lib/libraries.mjs';

const VERSION_FILES = [
  '.claude-plugin/plugin.json',
  'package.json',
  '.claude-plugin/marketplace.json',
  'CHANGELOG.md',
];

function normalizeTarget(raw, pr) {
  if (['personal', 'team', 'upstream'].includes(raw)) return { kind: raw, pr: Boolean(pr) };
  throw new Error(`--to 只支持 personal|team|upstream，收到：${raw}`);
}

function labelOf(kind) {
  return ({ upstream: '上游插件库', personal: '个人库', team: '团队库' })[kind] || kind;
}

function gitAt(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** 团队库默认只写工作区：必须是 git 顶层；目标文件已有未提交改动时拒绝，除非 --force。 */
function assertTeamWorkspace(teamRoot, plans, force) {
  const top = gitAt(teamRoot, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    throw new Error(`团队模板库必须是 git 仓库：${posix(teamRoot)}。先 git clone，或在该目录 git init。`);
  }
  const topDir = canonicalPath(top.stdout.trim());
  if (topDir !== canonicalPath(teamRoot)) {
    throw new Error(`团队模板库必须是 git 仓库顶层：${posix(teamRoot)} 位于 ${posix(topDir)} 内。`
      + '请把 templates.team.path 指到仓库根。');
  }

  const targets = plans.flatMap((plan) => plan.pending
    .map((file) => relPosix(teamRoot, file.targetAbs)));
  const dirty = [];
  for (const rel of targets) {
    if (!existsSync(join(teamRoot, ...rel.split('/')))) continue;
    const status = gitAt(teamRoot, ['status', '--porcelain', '--', rel]);
    if (status.status !== 0) throw new Error(`无法读取团队模板库状态：${(status.stderr || '').trim()}`);
    if (status.stdout.trim()) dirty.push(rel);
  }
  if (dirty.length && !force) {
    throw new Error(`团队模板库中目标文件有未提交改动：${dirty.join('、')}。`
      + '先提交，或加 --force（会先备份再覆盖）。');
  }

  const all = gitAt(teamRoot, ['status', '--porcelain']);
  if (all.status === 0) {
    const targetSet = new Set(targets);
    const unrelated = all.stdout.split('\n').filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, '').replace(/\/$/, ''))
      .filter((path) => {
        if (path === '.devflow' || path.startsWith('.devflow/')) return false;
        if (path === 'docs' || path === 'docs/upstream-log.md') return false;
        if (targetSet.has(path)) return false;
        // 未跟踪目录会被 git 折叠成 `templates/`：包含本次目标时不算无关改动。
        return !targets.some((target) => target.startsWith(`${path}/`));
      });
    if (unrelated.length) {
      log('warn', `团队模板库还有未提交改动（本次不处理）：${unrelated.slice(0, 5).join('、')}`
        + `${unrelated.length > 5 ? ' 等' : ''}`);
    }
  }
}

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

async function runRemote(argv, { root, pluginRoot, units, target }) {
  const { main: ship } = await import('./hub-ship.mjs');
  const args = ['--root', root, '--plugin-root', pluginRoot];
  if (target.kind === 'team') args.push('--profile', 'team');
  for (const unit of units) {
    if (unit.kind === 'stage') args.push('--stage', unit.name);
  }
  if (units.some((u) => u.kind === 'shared')) args.push('--shared');
  args.push(...passthrough(argv, ['--base', '--bump', '--remote', '--resume', '--pr-repo']));
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
  const force = hasFlag(argv, '--force');
  const rawTo = argValue(argv, '--to', null);
  const target = normalizeTarget(rawTo ?? 'upstream', hasFlag(argv, '--pr'));
  const revertId = argValue(argv, '--revert', null);
  const personalLibrary = argValue(argv, '--personal-library', null);
  const teamLibrary = argValue(argv, '--team-library', null);
  const pluginArg = argValue(argv, '--plugin-root', null);

  const bumpArg = argValue(argv, '--bump', null);
  // 无论是否 --apply，只要显式给了 --bump 就先校验，避免预览时静默忽略非法值。
  if (bumpArg !== null) bumpKind(bumpArg);
  if (target.kind !== 'upstream' && bumpArg !== null) {
    throw new Error('个人库与团队库没有版本文件，不支持 --bump。');
  }
  if (target.kind === 'personal' && target.pr) {
    throw new Error('个人库不支持 --pr；直接使用 --to personal 写入本地模板库。');
  }
  if (stage && !isValidStageName(stage)) {
    throw new Error(`阶段名非法：${stage}。只允许小写字母开头的 [a-z0-9_-]。`);
  }

  const { config } = loadHub(root);
  const meta = readMeta(root);
  const resolveOpts = { hubConfig: config, personalLibrary, teamLibrary, meta };
  const upstreamRoot = () => resolveUpstreamRoot(root, pluginArg);
  const resolveKind = (kind) => resolveLibraryRoot(root, kind, {
    ...resolveOpts,
    pluginRoot: kind === 'upstream' ? upstreamRoot() : null,
  }).root;

  if (revertId) {
    // 未指定 --to 时依次查找个人、团队、上游；显式 --to 只查该库，并直接暴露配置错误。
    const kinds = rawTo ? [target.kind] : ['personal', 'team', 'upstream'];
    for (const kind of kinds) {
      let libRoot;
      if (rawTo) libRoot = resolveKind(kind);
      else {
        try {
          libRoot = resolveKind(kind);
        } catch {
          continue;
        }
      }
      if (!readLog(libRoot).some((entry) => entry.id === revertId)) continue;
      if (kind === 'upstream') {
        if (isPluginCache(libRoot)) throw new Error(cacheGuardMessage(libRoot));
      } else {
        assertLibraryRoot(root, libRoot, kind);
      }
      const entry = revertFromLog(libRoot, revertId, { restoreVersionFiles: kind === 'upstream' });
      log('ok', `已回滚${labelOf(kind)}回灌记录 ${revertId}（${entry.files.length} 个模板文件）`);
      return { reverted: revertId, target: kind, files: entry.files };
    }
    throw new Error(`找不到回灌记录：${revertId}`);
  }

  const units = resolveUnits(root, { stage, shared, all });
  const libRoot = resolveKind(target.kind);
  const cacheTarget = target.kind === 'upstream' && isPluginCache(libRoot);
  if (cacheTarget && apply) throw new Error(cacheGuardMessage(libRoot));
  if (target.kind !== 'upstream') assertLibraryRoot(root, libRoot, target.kind);
  const info = target.kind === 'upstream' ? pluginInfo(libRoot) : null;

  if (target.pr) {
    return runRemote(argv, { root, pluginRoot: libRoot, units, target });
  }

  const plans = planUnits(root, libRoot, units, config);

  if (!json) {
    console.log(`目标：${labelOf(target.kind)} ${posix(libRoot)}`);
    for (const plan of plans) {
      console.log(`\n== ${plan.unit.kind === 'shared' ? '共享规则 .claude/hub/_shared' : `阶段 ${plan.unit.name}`} ==`);
      const counts = reportText([plan]);
      for (const file of plan.pending) {
        showDiff(file.verdict.content, file.targetAbs, `${plan.unit.name}/${file.rel}（项目 → ${labelOf(target.kind)}，已剔除敏感行）`);
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

  const summary = jsonReport(plans, {
    mode: target.kind,
    target: target.kind,
    targetRoot: posix(libRoot),
    applied: false,
  });

  if (!apply) {
    if (!json) {
      console.log(`\n预览完成：${totals.reusable} 个可回灌（${totals.pending} 个有变化），${totals.local} 个项目专属。`);
      if (target.kind === 'upstream') {
        console.log('加 --apply 才会写入插件模板；加 --to upstream --pr --apply 走分支 + PR。');
      } else {
        console.log(`加 --apply 才会写入${labelOf(target.kind)}；团队库默认只写工作区，不提交。`);
      }
      if (cacheTarget) log('warn', `目标是安装缓存（${posix(libRoot)}），--apply 会被拒绝，请用 --plugin-root 指向源码仓库。`);
    }
    return json ? { ...summary, ...totals } : { ...totals, applied: false, units: summary.units };
  }

  if (target.kind !== 'upstream') {
    const journalFile = join(libRoot, ...JOURNAL.split('/'));
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
      log('warn', `检测到上次未完成的回灌，继续完成 ${journal.units.join('、')}`);
    } else {
      if (!totals.pending) {
        if (!json) {
          console.log(totals.reusable ? '可回灌文件与目标库模板一致，未修改。' : '没有可回灌内容，未修改。');
        }
        return json ? { ...summary, ...totals, applied: false } : { ...totals, applied: false };
      }
      // 续做时工作区里的脏文件来自上次写入，不再拦截。
      if (target.kind === 'team') assertTeamWorkspace(libRoot, plans, force);
    }

    const pendingFiles = plans.flatMap((plan) => plan.pending);
    if (!journal) {
      journal = {
        id: makeId(),
        units: units.map((u) => `${u.kind}:${u.name}`),
        files: pendingFiles.map((file) => relPosix(libRoot, file.targetAbs)),
        created: pendingFiles.filter((file) => !existsSync(file.targetAbs))
          .map((file) => relPosix(libRoot, file.targetAbs)),
        createdAt: new Date().toISOString(),
      };
      writeAtomic(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
    }

    const result = applyPlan({ pending: pendingFiles }, libRoot, { backupId: journal.id });
    const written = [...new Set([...(journal.files || []), ...result.written])];
    const created = [...new Set([...(journal.created || []), ...result.created])];

    appendLog(libRoot, {
      id: journal.id,
      at: new Date().toISOString(),
      mode: target.kind,
      units: units.map((u) => (u.kind === 'shared' ? '共享规则' : `${u.name} 阶段`)),
      project: posix(root).split('/').pop(),
      files: written,
      created,
      oldVersion: null,
      newVersion: null,
    });

    rmSync(journalFile, { force: true });

    if (!json) {
      log('ok', `已回灌到${labelOf(target.kind)}：${written.length} 个文件`);
      if (target.kind === 'team') {
        log('..', '改动只写在工作区，未提交、未升版本；确认后自行 git add/commit/push，或用 --to team --pr 走分支与 PR。');
      } else {
        log('..', '个人库无需提交；其他项目执行 /devflow:sync 即可复用这些模板。');
      }
      log('ok', `回灌日志：${posix(join(libRoot, '.devflow', 'upstream-log.jsonl'))}`);
      log('ok', `可回滚：/devflow:upstream --to ${target.kind} --revert ${journal.id}`);
    }

    const body = { ...totals, applied: true, target: target.kind, id: journal.id, written };
    return json ? { ...summary, ...body } : body;
  }

  const kind = bumpArg === null ? null : bumpKind(bumpArg);

  // 上次中断可能停在“文件已复制、版本未升级”：先记账再写入，重跑时续做。
  const journalFile = join(libRoot, ...JOURNAL.split('/'));
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
  for (const rel of VERSION_FILES) backupFile(libRoot, backupId, rel);
  const result = applyPlan({ pending: plans.flatMap((p) => p.pending) }, libRoot, { backupId });
  // 中断续做时本次 pending 可能为空，历史清单仍要进入日志与回滚范围。
  const written = [...new Set([...(journal.files || []), ...result.written])];
  const created = [...new Set([...(journal.created || []), ...result.created])];

  if (journal.bumped) {
    updateVersionFiles(libRoot, journal.nextVersion);
    updateChangelog(libRoot, journal.nextVersion, units, written);
  }

  appendLog(libRoot, {
    id: backupId,
    at: new Date().toISOString(),
    mode: 'upstream',
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
    log('ok', `回灌日志：${posix(join(libRoot, '.devflow', 'upstream-log.jsonl'))}`);
    log('ok', `可回滚：/devflow:upstream --revert ${backupId}`);
  }

  return json
    ? { ...summary, ...totals, applied: true, target: 'upstream', version: journal.nextVersion, id: backupId, written }
    : { ...totals, applied: true, target: 'upstream', version: journal.nextVersion, id: backupId, written };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
