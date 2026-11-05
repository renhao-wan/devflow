#!/usr/bin/env node
// 审查触发与风险画像：读取任务产物与 git 改动，判定是否必须审查、
// 优先审哪些方向、最多派几个子代理；只读，--write 时把计划落盘。
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  argValue, hasFlag, hasOption, isMain, isPathInside, isRealPathInside, loadHub, projectRoot, readText, writeAtomic,
} from './lib/common.mjs';
import { checkReviewReport } from './lib/review-gate.mjs';
import { MISSING, resolveSlug } from './lib/slug.mjs';
import {
  DIRECTIONS,
  DIRECTION_LABELS,
  buildReviewPlan,
  collectChanges,
  detectFlow,
  evaluateEscalation,
  profileChanges,
  readReviewMarker,
  renderPlan,
  selfSourcePath,
} from './lib/review.mjs';

function collectFocus(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--focus') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--focus 需要方向名');
      out.push(...value.split(','));
    } else if (arg.startsWith('--focus=')) {
      const value = arg.slice('--focus='.length).trim();
      if (!value) throw new Error('--focus 需要方向名');
      out.push(...value.split(','));
    }
  }
  const focus = [...new Set(out.map((s) => s.trim()).filter(Boolean))];
  const invalid = focus.filter((d) => !DIRECTIONS.includes(d));
  if (invalid.length) {
    throw new Error(`未知审查方向：${invalid.join('、')}；可选：${DIRECTIONS.join('、')}`);
  }
  return focus;
}

function parseAgents(raw) {
  if (raw === null || raw === undefined) return null;
  if (!/^\d+$/.test(String(raw))) throw new Error(`--agents 需要 0-4 的整数，收到：${raw}`);
  const value = Number(raw);
  if (value > 4) throw new Error(`--agents 不能超过 4，收到：${raw}`);
  return value;
}

function checkBase(root, base) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`无法解析 --base：${base}`);
}

/**
 * 增量复审锚点必须是 HEAD 的祖先；rebase / force-push 后旧引用可能落空，
 * 这时 diff 会包含已审查内容或直接失败，宁可直接报错也不静默降级。
 */
function checkSince(root, since) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${since}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`无法解析 --since：${since}`);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', since, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (ancestor.status !== 0) {
    throw new Error(`--since ${since} 不是 HEAD 的祖先（可能已 rebase 或 force-push）；请改用 --base 或全量审查`);
  }
  return r.stdout.trim();
}

function gitHead(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function diffHashOf(changes) {
  const paths = changes.files.map((file) => file.path).sort().join('\n');
  return createHash('sha256').update(`${paths}\n${changes.diffText}`).digest('hex').slice(0, 12);
}

function collectGit(root, base, since = null) {
  const probes = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (probes.status !== 0 || probes.stdout.trim() !== 'true') {
    // 用户显式给了基线却读不到仓库时必须报错，不能静默按空改动继续。
    if (base) throw new Error('--base 需要 git 仓库；当前目录不是 git 仓库，请去掉 --base');
    if (since) throw new Error('--since 需要 git 仓库；当前目录不是 git 仓库，请改用全量审查');
    return {
      changes: {
        files: [], diffText: '', warnings: [], statsAvailable: false,
      },
      warnings: ['当前目录不是 git 仓库，无法统计实际改动；不会据空 diff 自动跳过审查。'],
      statsAvailable: false,
      head: null,
    };
  }
  if (base) checkBase(root, base);
  if (since) checkSince(root, since);
  const changes = collectChanges(root, { base, since });
  return {
    changes,
    warnings: changes.warnings,
    statsAvailable: changes.statsAvailable,
    head: gitHead(root),
  };
}

export function buildPlanFor(root, slug, {
  base = null,
  since = null,
  focus = [],
  agents = null,
  noSubagents = false,
  focusOnly = false,
} = {}) {
  const flow = detectFlow(root, slug);
  const reviewRequired = flow === 'light-bug' && readReviewMarker(root, slug) === 'required';
  const {
    changes, warnings, statsAvailable, head,
  } = collectGit(root, base, since);
  const plan = buildReviewPlan({
    flow,
    reviewRequired,
    files: changes.files,
    diffText: changes.diffText,
    focus,
    agents,
    noSubagents,
    focusOnly,
    statsAvailable,
    selfPath: selfSourcePath(root),
  });
  const scope = {
    mode: since ? 'incremental' : 'full',
    since: since || null,
    base: base || null,
    head,
    diffHash: diffHashOf(changes),
  };
  return { ...plan, scope, warnings };
}

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const write = hasFlag(argv, '--write');
  const check = hasFlag(argv, '--check');
  const escalate = hasFlag(argv, '--escalate');
  const noSubagents = hasFlag(argv, '--no-subagents');
  const focusOnly = hasFlag(argv, '--focus-only');
  const base = argValue(argv, '--base', null);
  const since = argValue(argv, '--since', null);
  if (base && since) throw new Error('--base 与 --since 不能同时使用');
  const focus = collectFocus(argv);
  if (focusOnly && focus.length) throw new Error('--focus-only 不能与 --focus 同时使用');
  const agentsRaw = argValue(argv, '--agents', null);
  // `--agents -1` 会被 argValue 当成“没传值”，必须显式报错而不是静默忽略。
  if (hasOption(argv, '--agents') && agentsRaw === null) {
    throw new Error('--agents 需要 0-4 的整数，例如 --agents 2');
  }
  const agents = parseAgents(agentsRaw);
  if (check && (write || focus.length || agents !== null || noSubagents || focusOnly || base || since)) {
    throw new Error('--check 只校验 review.md，不能与 --write/--focus/--agents/--no-subagents/--focus-only/--base/--since 同时使用');
  }
  if (escalate && (write || check || focus.length || agents !== null || noSubagents || focusOnly || since)) {
    throw new Error('--escalate 只读取 git 改动判断是否升级，不能与 --write/--check/--focus/--agents/--no-subagents/--focus-only/--since 同时使用');
  }

  if (escalate) {
    const collected = collectGit(root, base);
    const { changes, statsAvailable } = collected;
    const warnings = [...collected.warnings];
    const profile = profileChanges({
      files: changes.files,
      diffText: changes.diffText,
      selfPath: selfSourcePath(root),
    });
    let subprojects = {};
    try {
      subprojects = loadHub(root).config.subprojects || {};
    } catch (err) {
      // 子项目阈值只是升级判断的一部分；读取失败要显式说明判断不完整，不能静默当作没有子项目。
      warnings.push(`读取 .claude/hub 失败，子项目阈值未计入：${err.message}`);
    }
    const verdict = evaluateEscalation(profile, { statsAvailable, files: changes.files, subprojects });
    const result = { ...verdict, warnings: [...warnings, ...verdict.warnings] };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.escalate ? '[ESCALATE] 命中硬触发，停止轻量流程' : '[OK] 未命中可由 diff 推导的硬触发');
      for (const reason of result.reasons) console.log(`  - ${reason}`);
      for (const warning of result.warnings) console.log(`  注意：${warning}`);
      if (!result.escalate && result.confident) {
        console.log('  仍需人工核对：根因范围、假设是否收敛、不可逆操作与跨模块影响。');
      }
    }
    if (result.escalate) process.exitCode = 1;
    return result;
  }

  const slug = resolveSlug(root, argValue(argv, '--slug', null));
  if (slug === MISSING) {
    console.error(`[ERR] 未找到任务：${argValue(argv, '--slug', null)}（查找 docs/devflow/${argValue(argv, '--slug', null)}/）`);
    process.exitCode = 1;
    return null;
  }

  if (check) {
    const triageFile = join(root, 'docs', 'devflow', slug, 'review-triage.json');
    let triage = null;
    if (existsSync(triageFile)) {
      try { triage = JSON.parse(readText(triageFile)); } catch { triage = null; }
    }
    const result = { slug, ...checkReviewReport(root, slug, { triage }) };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`审查门禁（slug：${slug}）`);
      for (const error of result.errors) console.log(`[ERR] ${error}`);
      for (const warning of result.warnings) console.log(`[WARN] ${warning}`);
      if (result.ok) console.log('[OK] 审查报告已满足 triage 要求');
    }
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  const plan = buildPlanFor(root, slug, { base, since, focus, agents, noSubagents, focusOnly });
  plan.slug = slug;

  if (write) {
    const rel = `docs/devflow/${slug}/review-triage.json`;
    const out = join(root, 'docs', 'devflow', slug, 'review-triage.json');
    // 目录或文件可能是符号链接/junction，不能只看词法路径。
    if (!isPathInside(root, out) || !isRealPathInside(root, out)) {
      throw new Error(`拒绝写入 ${rel}：目标指向项目外部`);
    }
    writeAtomic(out, `${JSON.stringify(plan, null, 2)}\n`);
  }

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }

  console.log(`审查计划（slug：${slug}）`);
  console.log(renderPlan(plan).split('\n').map((line) => `  ${line}`).join('\n'));
  for (const warning of plan.warnings) console.log(`  注意：${warning}`);
  if (write) console.log(`  已写入：docs/devflow/${slug}/review-triage.json`);
  return plan;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
