#!/usr/bin/env node
// 审查触发与风险画像：读取任务产物与 git 改动，判定是否必须审查、
// 优先审哪些方向、最多派几个子代理；只读，--write 时把计划落盘。
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  argValue, hasFlag, isMain, isPathInside, isRealPathInside, projectRoot, writeAtomic,
} from './lib/common.mjs';
import {
  DIRECTIONS,
  DIRECTION_LABELS,
  buildReviewPlan,
  collectChanges,
  detectFlow,
  readReviewMarker,
  renderPlan,
} from './lib/review.mjs';

const MISSING = Symbol('missing');

function collectFocus(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--focus') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--focus 需要方向名');
      out.push(...value.split(','));
    } else if (arg.startsWith('--focus=')) {
      out.push(...arg.slice('--focus='.length).split(','));
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

function validSlug(slug) {
  return Boolean(slug) && !slug.includes('..') && !/[\\/]/.test(slug);
}

function listCandidates(root) {
  const docs = join(root, 'docs', 'devflow');
  if (!existsSync(docs)) return [];
  return readdirSync(docs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => ['req.md', 'plan.md', 'brief.md', 'debug.md']
      .some((file) => existsSync(join(docs, name, file))));
}

function resolveSlug(root, wanted) {
  if (wanted) {
    if (!validSlug(wanted)) throw new Error(`非法的 slug：${wanted}`);
    if (!existsSync(join(root, 'docs', 'devflow', wanted))) {
      return MISSING;
    }
    return wanted;
  }
  const candidates = listCandidates(root);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    throw new Error('未发现任务；先运行 /devflow:req、/devflow:debug 或指定 --slug');
  }
  throw new Error(`存在多个任务，请指定 --slug：${candidates.join('、')}`);
}

function checkBase(root, base) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`无法解析 --base：${base}`);
}

function collectGit(root, base) {
  const probes = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (probes.status !== 0 || probes.stdout.trim() !== 'true') {
    return {
      changes: {
        files: [], diffText: '', warnings: [], statsAvailable: false,
      },
      warnings: ['当前目录不是 git 仓库，无法统计实际改动；不会据空 diff 自动跳过审查。'],
      statsAvailable: false,
    };
  }
  if (base) checkBase(root, base);
  const changes = collectChanges(root, { base });
  return { changes, warnings: changes.warnings, statsAvailable: changes.statsAvailable };
}

export function buildPlanFor(root, slug, {
  base = null,
  focus = [],
  agents = null,
  noSubagents = false,
  focusOnly = false,
} = {}) {
  const flow = detectFlow(root, slug);
  const reviewRequired = flow === 'light-bug' && readReviewMarker(root, slug) === 'required';
  const { changes, warnings, statsAvailable } = collectGit(root, base);
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
  });
  return { ...plan, warnings };
}

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const write = hasFlag(argv, '--write');
  const noSubagents = hasFlag(argv, '--no-subagents');
  const focusOnly = hasFlag(argv, '--focus-only');
  const base = argValue(argv, '--base', null);
  const focus = collectFocus(argv);
  if (focusOnly && focus.length) throw new Error('--focus-only 不能与 --focus 同时使用');
  const agents = parseAgents(argValue(argv, '--agents', null));

  const slug = resolveSlug(root, argValue(argv, '--slug', null));
  if (slug === MISSING) {
    console.error(`[ERR] 未找到任务：${argValue(argv, '--slug', null)}（查找 docs/devflow/${argValue(argv, '--slug', null)}/）`);
    process.exitCode = 1;
    return null;
  }

  const plan = buildPlanFor(root, slug, { base, focus, agents, noSubagents, focusOnly });
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
