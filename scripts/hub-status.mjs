#!/usr/bin/env node
// 只读进度视图：扫描 docs/devflow/<slug>/ 的产物与 .devflow-state.json，
// 推导每个任务所处阶段并给出下一步命令；不写入任何状态。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readText, isMain, projectRoot, argValue, hasFlag, posix } from './lib/common.mjs';
import { checkReviewReport } from './lib/review-gate.mjs';
import { collectChanges } from './lib/review.mjs';
import { planDriftFor } from './lib/plan-drift.mjs';
import { summarizeTrace, traceFor } from './lib/trace.mjs';
import {
  isStale, listAvailableTools, loadEcosystem, loadState,
} from './lib/ecosystem.mjs';

const ARTIFACTS = ['req.md', 'plan.md', 'brief.md', 'debug.md', 'test.md', 'review.md'];

const FLOW_LABEL = {
  'light-feature': '轻量功能',
  'light-bug': '轻量修复',
};

const NEXT = {
  req: (slug) => `/devflow:req <需求描述>（slug：${slug}）`,
  plan: (slug) => `/devflow:plan ${slug}`,
  implement: (slug) => `/devflow:implement ${slug}`,
  test: (slug) => `/devflow:test ${slug}`,
  review: (slug) => `/devflow:review ${slug}`,
  done: () => '提交或交付；若改过阶段规则，运行 /devflow:upstream --stage <stage> 回灌',
};

const GAP = {
  req: 'req.md',
  plan: 'plan.md',
  implement: null,
  test: 'test.md',
  review: 'review.md',
  done: null,
};

function readState(root) {
  const file = join(root, '.claude', '.devflow-state.json');
  if (!existsSync(file)) return {};
  try { return JSON.parse(readText(file)); } catch { return {}; }
}

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

function scanSlugs(root) {
  const docs = join(root, 'docs', 'devflow');
  if (!existsSync(docs)) return [];
  const slugs = [];
  for (const entry of readdirSync(docs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(docs, entry.name);
    const files = ARTIFACTS.filter((name) => existsSync(join(dir, name)));
    const latest = Math.max(mtimeOf(dir), ...files.map((name) => mtimeOf(join(dir, name))));
    slugs.push({ slug: entry.name, files, latest });
  }
  return slugs.sort((a, b) => b.latest - a.latest);
}

function flowOf(files) {
  const has = (name) => files.includes(name);
  if (has('req.md') || has('plan.md')) return 'full';
  if (has('brief.md')) return 'light-feature';
  if (has('debug.md')) return 'light-bug';
  return 'unknown';
}

// 优先读取审查 triage 结果；没有时回退 debug.md 的 review: required 标记。
function triageOf(root, slug) {
  const file = join(root, 'docs', 'devflow', slug, 'review-triage.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readText(file));
    return typeof data.trigger === 'string' ? data : null;
  } catch {
    return null;
  }
}

/** triage 快照早于 debug.md 时可能已过期，只提示重跑，不改变阶段判定。 */
function triageIsStale(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  return mtimeOf(join(dir, 'debug.md')) > mtimeOf(join(dir, 'review-triage.json'));
}

// 只读 debug.md 前 10 行判断是否需要独立 review；读取失败按普通小 bug 处理。
// 标记须独占一行且为小写，可带引号；写在正文后面不生效。
function needsReview(root, slug) {
  const file = join(root, 'docs', 'devflow', slug, 'debug.md');
  if (!existsSync(file)) return false;
  try {
    const head = readText(file).split(/\r?\n/).slice(0, 10).join('\n');
    return /^review:\s*['"]?required['"]?\s*$/m.test(head);
  } catch {
    return false;
  }
}

function stageOf(files, testsPending, reviewRequired = false) {
  const has = (name) => files.includes(name);

  // 完整流程优先：一旦出现 req.md / plan.md，原有四产物推断保持不变。
  if (has('req.md') || has('plan.md')) {
    if (!has('req.md')) return 'req';
    if (!has('plan.md')) return 'plan';
    // 代码改动晚于最近一次测试时，即使已有 review.md 也应回到 test。
    if (testsPending) return 'test';
    // review 不能早于测试证据：缺少 test.md 时先补测试，不因 review.md 直接判完成。
    if (has('review.md') && !has('test.md')) return 'test';
    if (has('review.md')) return 'done';
    if (has('test.md')) return 'review';
    return 'implement';
  }

  // 轻量功能：brief 替代 req + plan，review 始终保留。
  if (has('brief.md')) {
    if (testsPending) return 'test';
    if (has('test.md')) return has('review.md') ? 'done' : 'review';
    if (has('review.md')) return 'test';
    return 'implement';
  }

  // 轻量修复：debug 替代 req + plan + implement。
  if (has('debug.md')) {
    if (testsPending) return 'test';
    if (has('test.md')) {
      if (!has('review.md') && reviewRequired) return 'review';
      return 'done';
    }
    return 'test';
  }

  return 'req';
}

export function buildStatus(root, { wanted = null, drift = true } = {}) {
  const state = readState(root);

  let slugs = scanSlugs(root);
  if (wanted) {
    slugs = slugs.filter((s) => s.slug === wanted);
    if (!slugs.length) return { missing: true };
  }

  // 只读一次 diff，供所有任务复用；非 git 或读取失败时返回 null，不影响阶段推导。
  let changes = null;
  if (drift && slugs.length) {
    try { changes = collectChanges(root); } catch { changes = null; }
  }

  // 只有一个任务（或显式指定）时，才能把全局 testsPending 归到它名下。
  const activeSlug = wanted || (slugs.length === 1 ? slugs[0].slug : null);
  const testsPending = Boolean(state.testsPending);
  const rows = slugs.map((item) => {
    const pending = testsPending && item.slug === activeSlug;
    const flow = flowOf(item.files);
    // reviewRequired 只对轻量修复有意义：轻量功能始终 review，完整流程也会 review。
    const triage = flow === 'light-bug' ? triageOf(root, item.slug) : null;
    const markerRequired = flow === 'light-bug' ? needsReview(root, item.slug) : false;
    // 显式标记优先于 triage 的跳过结论，避免后续补标记被旧快照覆盖。
    const reviewRequired = flow === 'light-bug'
      ? (markerRequired || (triage ? triage.trigger !== 'skipped' : false))
      : false;
    const triageStale = triage ? triageIsStale(root, item.slug) : false;
    let stage = stageOf(item.files, pending, reviewRequired);
    // review.md 存在时校验内容；有未关闭阻断项或画像缺失时不能判完成。
    const reviewGate = item.files.includes('review.md') && (stage === 'done' || stage === 'review')
      ? checkReviewReport(root, item.slug, { triage: triageOf(root, item.slug) })
      : null;
    if (reviewGate && !reviewGate.ok && stage === 'done') stage = 'review';
    const gap = stage === 'review' && item.files.includes('review.md') ? null : GAP[stage];
    const planDrift = changes ? planDriftFor(root, item.slug, { changes }) : null;
    const trace = summarizeTrace(traceFor(root, item.slug));
    return {
      slug: item.slug,
      stage,
      flow,
      reviewRequired,
      trace: trace.skipped ? null : trace,
      reviewTriage: triage
        ? { trigger: triage.trigger, level: triage.level ?? null, stale: triageStale }
        : null,
      reviewGate: reviewGate
        ? { ok: reviewGate.ok, errors: reviewGate.errors, warnings: reviewGate.warnings }
        : null,
      planDrift,
      artifacts: item.files,
      gap,
      next: NEXT[stage](item.slug),
    };
  });

  const suggestions = [];
  if (!rows.length) {
    suggestions.push('未发现进行中的任务；新功能：/devflow:req <需求描述>（小改动加 --light）；修复缺陷：/devflow:debug <问题>');
  }
  if (!wanted && slugs.length > 1) {
    suggestions.push(`存在 ${slugs.length} 个任务；执行工作流命令时请显式带上 slug，或先运行 /devflow:status --slug <slug>`);
  }
  if (testsPending) {
    suggestions.push(`有改动尚未验证；运行 /devflow:test ${activeSlug || '<slug>'}，通过后运行 node scripts/devflow-test.mjs --command "<命令>"`);
  }
  if (state.lastTestStatus === 'failed') {
    suggestions.push(`上次测试失败（exit ${state.lastTestExitCode ?? '?'}）；修复后重新运行并用 node scripts/devflow-test.mjs 记录结果`);
  }
  for (const row of rows) {
    if (!row.planDrift || row.planDrift.skipped) continue;
    if (row.planDrift.unplannedChanged.length) {
      suggestions.push(`${row.slug}：有 ${row.planDrift.unplannedChanged.length} 个改动未列入计划（${row.planDrift.unplannedChanged.slice(0, 3).join('、')}${row.planDrift.unplannedChanged.length > 3 ? ' 等' : ''}）；确认是否需要更新计划或补测试`);
    }
    if (row.planDrift.plannedButUnchanged.length) {
      suggestions.push(`${row.slug}：计划中的 ${row.planDrift.plannedButUnchanged.length} 个文件尚未改动；若已放弃请更新计划`);
    }
  }
  for (const row of rows) {
    if (row.trace && row.trace.gaps > 0) {
      const ids = row.trace.gapIds.slice(0, 3).join('、');
      suggestions.push(`${row.slug}：验收跟踪 ${row.trace.covered}/${row.trace.total} 已覆盖，缺口 ${ids}${row.trace.gapIds.length > 3 ? ' 等' : ''}；补齐证据或运行 devflow trace --slug ${row.slug} --check`);
    }
  }
  for (const row of rows) {
    if (row.reviewGate && !row.reviewGate.ok) {
      suggestions.push(`${row.slug}：审查报告未通过门禁（${row.reviewGate.errors[0]}）；运行 /devflow:review ${row.slug} 补全后重跑 devflow status`);
    }
  }
  // 投影时间戳晚于最近一次阶段源改动时视为已生成，不再反复提示。
  const lastHubChange = Date.parse(state.lastHubChangeAt || '');
  const hubGenerated = mtimeOf(join(root, '.claude', '.hub-manifest.json')) >= lastHubChange
    && !Number.isNaN(lastHubChange);
  if (state.hubPending && !hubGenerated) {
    suggestions.push('阶段源（.claude/hub/）有改动；运行 node scripts/devflow-gen.mjs 重新生成投影');
  }

  const eco = loadEcosystem(root);
  const ecoState = loadState(root);
  const availableTools = listAvailableTools(eco.config, ecoState.state).map((tool) => tool.id);
  const stale = !ecoState.exists || Boolean(ecoState.error)
    || isStale(ecoState.state, eco.config.routing.detectMaxAgeDays);
  if (!eco.exists) {
    suggestions.push('未配置 .claude/hub/ecosystem.yaml；运行 /devflow:init 可启用工具路由');
  } else if (eco.error) {
    suggestions.push(`ecosystem.yaml 解析失败，路由回退默认配置：${eco.error}`);
  } else if (stale) {
    suggestions.push('工具检测结果缺失或过期；运行 devflow route --detect 更新');
  }

  const lastTest = state.lastTestStatus
    ? {
      status: state.lastTestStatus,
      exitCode: state.lastTestExitCode ?? null,
      durationMs: state.lastTestDurationMs ?? null,
      command: state.lastTestCommand ?? null,
      at: state.lastTestAt ?? null,
    }
    : null;

  const report = {
    root: posix(root),
    activeSlug,
    inferred: Boolean(activeSlug && !wanted),
    slugs: rows,
    state: { testsPending, hubPending: Boolean(state.hubPending), lastTest },
    routing: {
      configured: eco.exists,
      mode: eco.config.routing.mode,
      availableTools,
      stale,
    },
    suggestions,
  };
  return { report };
}

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const wanted = argValue(argv, '--slug', null);

  const result = buildStatus(root, { wanted });
  if (result.missing) {
    console.error(`[ERR] 未找到任务：${wanted}（查找 docs/devflow/${wanted}/）`);
    process.exitCode = 1;
    return null;
  }
  const { report } = result;

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`devflow 状态（根：${report.root}）`);
  if (!report.slugs.length) {
    console.log('  未发现 docs/devflow/ 下的任务。');
    console.log('    新功能：/devflow:req <需求>（小改动加 --light）');
    console.log('    修复缺陷：/devflow:debug <问题描述>');
  } else {
    for (const row of report.slugs) {
      const produced = row.artifacts.length ? row.artifacts.join(', ') : '（无）';
      const flow = FLOW_LABEL[row.flow] ? `  模式：${FLOW_LABEL[row.flow]}` : '';
      const review = row.reviewRequired && row.stage !== 'done' ? '，需补审查' : '';
      const triage = row.reviewTriage?.trigger === 'skipped' ? '，审查已跳过（triage）' : '';
      const stale = row.reviewTriage?.stale ? '，triage 可能过期，建议重跑' : '';
      const gate = row.reviewGate && !row.reviewGate.ok ? '，审查报告未通过门禁' : '';
      const gap = row.gap ? `（缺少 ${row.gap}）` : '';
      console.log(`  ${row.slug}`);
      console.log(`    阶段：${row.stage}${flow}${review}${triage}${stale}${gate}`);
      console.log(`    产物：${produced}${gap}`);
      if (row.trace && row.trace.gaps > 0) {
        console.log(`    验收跟踪：${row.trace.covered}/${row.trace.total} 已覆盖，缺口 ${row.trace.gapIds.join('、')}`);
      }
      console.log(`    下一步：${row.next}`);
      if (row.planDrift && !row.planDrift.skipped) {
        const unplanned = row.planDrift.unplannedChanged;
        const missing = row.planDrift.plannedButUnchanged;
        if (unplanned.length) {
          console.log(`    计划外改动：${unplanned.slice(0, 5).join('、')}${unplanned.length > 5 ? ` 等 ${unplanned.length} 个` : ''}`);
        }
        if (missing.length) {
          console.log(`    计划未改动：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`);
        }
      }
    }
    if (report.activeSlug && !wanted && report.slugs.length === 1) {
      console.log(`  未传 --slug 时默认使用：${report.activeSlug}`);
    }
  }
  const tools = report.routing.availableTools.length
    ? report.routing.availableTools.join('、')
    : '无（运行 devflow route --detect 更新）';
  console.log(`  路由：${report.routing.mode}${report.routing.configured ? '' : '（未配置）'}；可用工具：${tools}`);
  if (report.state.lastTest) {
    const test = report.state.lastTest;
    console.log(`  最近测试：${test.status}${test.exitCode !== null ? `（exit ${test.exitCode}）` : ''}${test.durationMs !== null ? `，${test.durationMs}ms` : ''}`);
  }
  const visibleSuggestions = report.slugs.length
    ? report.suggestions
    : report.suggestions.filter((s) => !s.startsWith('未发现进行中的任务'));
  for (const item of visibleSuggestions) console.log(`  提示：${item}`);
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
