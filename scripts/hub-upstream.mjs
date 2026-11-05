#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  argValue, hasFlag, log, posix, isMain, projectRoot, readText, writeAtomic,
  resolveUpstreamRoot, isPluginCache, cacheGuardMessage, loadHub,
  isValidStageName, canonicalPath, relPosix, readMeta, contentHash,
} from './lib/common.mjs';
import { isValidStackName } from './lib/stacks.mjs';
import {
  JOURNAL, resolveUnits, planUnits, applyPlan, makeId,
  appendLog, readLog, revertFromLog,
} from './lib/upstream.mjs';
import { resolveLibraryRoot, assertLibraryRoot } from './lib/libraries.mjs';

function normalizeTarget(raw, pr) {
  if (['personal', 'team', 'upstream'].includes(raw)) return { kind: raw, pr: Boolean(pr) };
  throw new Error(`--to 只支持 personal|team|upstream，收到：${raw}`);
}

function labelOf(kind) {
  return ({ upstream: '上游插件库', personal: '个人库', team: '团队库' })[kind] || kind;
}

function argValues(argv, name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
}

function unitLabel(unit) {
  if (unit.kind === 'shared') return '共享规则';
  if (unit.kind === 'stack') return `${unit.name} 技术栈`;
  return `${unit.name} 阶段`;
}

function unitPath(unit, rel) {
  if (unit.kind === 'shared') return `_shared/${rel}`;
  if (unit.kind === 'stack') return `stacks/${unit.name}/${rel}`;
  return `${unit.name}/${rel}`;
}

function gitAt(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** 团队库默认只写工作区：必须是 git 顶层；目标文件已有未提交改动时拒绝，除非 --force。 */
function assertTeamWorkspace(teamRoot, plans, force, { allowDirty = new Set() } = {}) {
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
    if (allowDirty.has(rel)) continue;
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

/**
 * 续做前确认 journal 记录的文件没有被中断后的手工修改覆盖：
 * 当前内容应等于“写入后”或“写入前”的哈希；两者都不是，说明中断后有人改过。
 */
function assertResumeTargets(libRoot, journal, force) {
  if (!journal.hashes || !journal.before) return;
  const changed = [];
  for (const rel of journal.files || []) {
    const abs = join(libRoot, ...rel.split('/'));
    const now = existsSync(abs) ? contentHash(readText(abs)) : null;
    if (now === journal.hashes[rel] || now === journal.before[rel]) continue;
    changed.push(rel);
  }
  if (!changed.length) return;
  if (!force) {
    throw new Error(`上次回灌的文件在中断后被修改或删除：${changed.join('、')}。`
      + '先还原或提交这些改动，确认以本次回灌覆盖时加 --force。');
  }
  log('warn', `续做将覆盖中断后被修改的文件：${changed.join('、')}`);
}

function showDiff(content, target, label) {
  if (!existsSync(target)) {
    // git diff --no-index 对不存在的文件可能输出空 diff，不能据此显示“内容一致”。
    console.log(`\n--- ${label}（新增） ---`);
    console.log(content || '（空文件）');
    return;
  }
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
      const rel = unitPath(plan.unit, file.rel);
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
      unit: p.unit.kind === 'shared' ? '_shared' : (p.unit.kind === 'stack' ? `stacks/${p.unit.name}` : p.unit.name),
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
    else if (unit.kind === 'stack') args.push('--stack', unit.name);
  }
  if (units.some((u) => u.kind === 'shared')) args.push('--shared');
  args.push(...passthrough(argv, ['--base', '--remote', '--resume', '--pr-repo']));
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
  const stacks = argValues(argv, '--stack');
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

  if (target.kind === 'personal' && target.pr) {
    throw new Error('个人库不支持 --pr；直接使用 --to personal 写入本地模板库。');
  }
  if (stage && !isValidStageName(stage)) {
    throw new Error(`阶段名非法：${stage}。只允许小写字母开头的 [a-z0-9_-]。`);
  }
  for (const stack of stacks) {
    if (!isValidStackName(stack)) {
      throw new Error(`技术栈名非法：${stack}。只允许 [a-z0-9][a-z0-9_-]*。`);
    }
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

  const units = resolveUnits(root, {
    stage,
    shared,
    stacks,
    all,
    onSkip: (names) => log('warn', `跳过无法声明的技术栈目录：${names.join('、')}（只允许 [a-z0-9][a-z0-9_-]*）`),
  });
  const libRoot = resolveKind(target.kind);
  const cacheTarget = target.kind === 'upstream' && isPluginCache(libRoot);
  if (cacheTarget && apply) throw new Error(cacheGuardMessage(libRoot));
  if (target.kind !== 'upstream') assertLibraryRoot(root, libRoot, target.kind);

  if (target.pr) {
    return runRemote(argv, { root, pluginRoot: libRoot, units, target });
  }

  const plans = planUnits(root, libRoot, units, config);

  if (!json) {
    console.log(`目标：${labelOf(target.kind)} ${posix(libRoot)}`);
    for (const plan of plans) {
      console.log(`\n== ${unitLabel(plan.unit)} ==`);
      const counts = reportText([plan]);
      for (const file of plan.pending) {
        showDiff(file.verdict.content, file.targetAbs, `${unitPath(plan.unit, file.rel)}（项目 → ${labelOf(target.kind)}，已剔除敏感行）`);
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
      // 中断后目标文件可能被手工改过：放行上次写入的文件，但内容必须对得上。
      assertResumeTargets(libRoot, journal, force);
      if (target.kind === 'team') {
        assertTeamWorkspace(libRoot, plans, force, { allowDirty: new Set(journal.files || []) });
      }
    } else {
      if (!totals.pending) {
        if (!json) {
          console.log(totals.reusable ? '可回灌文件与目标库模板一致，未修改。' : '没有可回灌内容，未修改。');
        }
        return json ? { ...summary, ...totals, applied: false } : { ...totals, applied: false };
      }
      // 首次写入前检查团队库工作区；续做路径在上面单独处理。
      if (target.kind === 'team') assertTeamWorkspace(libRoot, plans, force);
    }

    const pendingFiles = plans.flatMap((plan) => plan.pending);
    if (!journal) {
      const files = pendingFiles.map((file) => relPosix(libRoot, file.targetAbs));
      // 续做时用它区分“上次已写入”与“中断后被手工修改”的文件。
      const hashes = {};
      const before = {};
      for (const file of pendingFiles) {
        const rel = relPosix(libRoot, file.targetAbs);
        hashes[rel] = contentHash(file.verdict.content);
        before[rel] = existsSync(file.targetAbs) ? contentHash(readText(file.targetAbs)) : null;
      }
      journal = {
        id: makeId(),
        units: units.map((u) => `${u.kind}:${u.name}`),
        files,
        created: pendingFiles.filter((file) => !existsSync(file.targetAbs))
          .map((file) => relPosix(libRoot, file.targetAbs)),
        hashes,
        before,
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
      units: units.map(unitLabel),
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

  // 先记账再写入，中断后重跑同一命令可续做。
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
        console.log(totals.reusable ? '可回灌文件与插件模板一致，未修改插件。' : '没有可回灌内容，未修改插件。');
      }
      return json ? { ...summary, ...totals, applied: false } : { ...totals, applied: false };
    }
    journal = {
      id: makeId(),
      units: units.map((u) => `${u.kind}:${u.name}`),
      files: plans.flatMap((plan) => plan.pending.map((f) => `${plan.unit.targetRel}/${f.rel}`)),
      created: plans.flatMap((plan) => plan.pending
        .filter((f) => !existsSync(f.targetAbs))
        .map((f) => `${plan.unit.targetRel}/${f.rel}`)),
      createdAt: new Date().toISOString(),
    };
    writeAtomic(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  }

  const backupId = journal.id;
  const result = applyPlan({ pending: plans.flatMap((p) => p.pending) }, libRoot, { backupId });
  // 中断续做时本次 pending 可能为空，历史清单仍要进入日志与回滚范围。
  const written = [...new Set([...(journal.files || []), ...result.written])];
  const created = [...new Set([...(journal.created || []), ...result.created])];

  appendLog(libRoot, {
    id: backupId,
    at: new Date().toISOString(),
    mode: 'upstream',
    units: units.map(unitLabel),
    project: posix(root).split('/').pop(),
    files: written,
    created,
    oldVersion: null,
    newVersion: null,
  });

  rmSync(journalFile, { force: true });

  if (!json) {
    log('ok', `已回灌 ${written.length} 个文件`);
    log('ok', `回灌日志：${posix(join(libRoot, '.devflow', 'upstream-log.jsonl'))}`);
    log('ok', `可回滚：/devflow:upstream --revert ${backupId}`);
  }

  return json
    ? { ...summary, ...totals, applied: true, target: 'upstream', id: backupId, written }
    : { ...totals, applied: true, target: 'upstream', id: backupId, written };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
