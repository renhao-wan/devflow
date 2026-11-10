#!/usr/bin/env node
// 只读进度视图：扫描 docs/devflow/<slug>/ 的产物与 .devflow-state.json，
// 推导每个任务所处阶段并给出下一步命令；不写入任何状态。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readText, isMain, projectRoot, argValue, hasFlag, posix, warnUnknownArgs } from './lib/common.mjs';
import { checkReviewReport } from './lib/review-gate.mjs';
import { collectChanges } from './lib/review.mjs';
import { planDriftFor } from './lib/plan-drift.mjs';
import { isTaskDir, validSlug } from './lib/slug.mjs';
import { summarizeTrace, traceFor } from './lib/trace.mjs';
import {
  ARTIFACTS, flowOf, chainOf, staleDownstream, duplicateGroups,
} from './lib/artifact-chain.mjs';
import {
  isStale, listAvailableTools, loadEcosystem, loadState,
} from './lib/ecosystem.mjs';

const FLOW_LABEL = {
  'light-feature': '轻量功能',
  'light-bug': '轻量修复',
};

const NEXT = {
  req: (slug) => `/devflow:req <需求描述>（slug：${slug}）`,
  plan: (slug) => `/devflow:plan ${slug}`,
  implement: (slug) => `继续实现：/devflow:implement ${slug}；代码已完成可直接 /devflow:test ${slug}`,
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
  try {
    const data = JSON.parse(readText(file));
    // 手改或写入中断可能留下 null / 数组，按空状态处理，避免读取属性时崩溃。
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/** 去掉标题与空行后是否还有内容；只有标题的空壳产物不算进入该阶段。 */
function hasSubstance(file) {
  try {
    const body = readText(file)
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('');
    return body.trim().length > 0;
  } catch {
    return false;
  }
}

// 只取需求/轻量功能的一级标题；debug.md 的标题是通用“排障记录”，不适合做重复判断。
function titleOf(dir, files) {
  const file = files.includes('req.md') ? 'req.md' : files.includes('brief.md') ? 'brief.md' : null;
  if (!file) return null;
  try {
    const line = readText(join(dir, file)).split(/\r?\n/).find((item) => /^#\s+\S/.test(item));
    return line ? line.replace(/^#\s+/, '').trim() : null;
  } catch {
    return null;
  }
}

function scanSlugs(root) {
  const docs = join(root, 'docs', 'devflow');
  if (!existsSync(docs)) return [];
  const slugs = [];
  for (const entry of readdirSync(docs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(docs, entry.name);
    // 与 listCandidates 保持同一口径：只有 test.md/review.md 的目录不是任务。
    if (!isTaskDir(dir)) continue;
    const files = ARTIFACTS.filter((name) => existsSync(join(dir, name)));
    const substantive = new Set(files.filter((name) => hasSubstance(join(dir, name))));
    const mtimes = Object.fromEntries(files.map((name) => [name, mtimeOf(join(dir, name))]));
    const latest = Math.max(mtimeOf(dir), ...files.map((name) => mtimeOf(join(dir, name))));
    slugs.push({ slug: entry.name, files, substantive, latest, mtimes, title: titleOf(dir, files) });
  }
  return slugs.sort((a, b) => b.latest - a.latest);
}

/** 只有 .archive、没有入口产物的目录是已归档任务；正常任务目录里的归档不重复计入。 */
function scanArchived(root) {
  const docs = join(root, 'docs', 'devflow');
  if (!existsSync(docs)) return [];
  const archived = [];
  for (const entry of readdirSync(docs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(docs, entry.name);
    if (isTaskDir(dir)) continue;
    if (existsSync(join(dir, '.archive'))) archived.push(entry.name);
  }
  return archived.sort();
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

/** triage 快照与调试记录或审查报告不一致时可能已过期，只提示重跑，不改变阶段判定。 */
function triageIsStale(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  const triage = mtimeOf(join(dir, 'review-triage.json'));
  if (!triage) return false;
  const debug = mtimeOf(join(dir, 'debug.md'));
  const review = mtimeOf(join(dir, 'review.md'));
  // debug 更新说明排查记录变了；triage 晚于 review 说明重跑 triage 后没有重写审查报告。
  return Boolean((debug && debug > triage) || (review && triage > review));
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

function stageOf(files, testsPending, reviewRequired = false, substantive = new Set(files)) {
  const has = (name) => files.includes(name);
  // 空的 test.md 只是占位，不构成测试证据，不能据此进入 review/done。
  const testDone = has('test.md') && substantive.has('test.md');

  // 完整流程优先：一旦出现 req.md / plan.md，原有四产物推断保持不变。
  if (has('req.md') || has('plan.md')) {
    if (!has('req.md')) return 'req';
    if (!has('plan.md')) return 'plan';
    // 代码改动晚于最近一次测试时，即使已有 review.md 也应回到 test。
    if (testsPending) return 'test';
    // review 不能早于测试证据：缺少有效 test.md 时先补测试，不因 review.md 直接判完成。
    if (!testDone) return has('review.md') ? 'test' : 'implement';
    if (has('review.md')) return 'done';
    return 'review';
  }

  // 轻量功能：brief 替代 req + plan，review 始终保留。
  if (has('brief.md')) {
    if (testsPending) return 'test';
    if (!testDone) return has('review.md') ? 'test' : 'implement';
    return has('review.md') ? 'done' : 'review';
  }

  // 轻量修复：debug 替代 req + plan + implement。
  if (has('debug.md')) {
    if (testsPending) return 'test';
    if (!testDone) return 'test';
    if (!has('review.md') && reviewRequired) return 'review';
    return 'done';
  }

  return 'req';
}

export function buildStatus(root, { wanted = null, drift = true } = {}) {
  const state = readState(root);
  const initialized = existsSync(join(root, '.claude', 'hub', 'hub.yaml'));

  const allSlugs = scanSlugs(root);
  let slugs = allSlugs;
  if (wanted) {
    slugs = slugs.filter((s) => s.slug === wanted);
    if (!slugs.length) {
      if (scanArchived(root).includes(wanted)) return { archived: true, slug: wanted };
      return { missing: true };
    }
  }
  // 重复检测基于全部任务：按 --slug 查询单个任务时也要能发现另一套。
  const duplicates = duplicateGroups(allSlugs);

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
    // triage 快照既用于轻量修复的流程判定，也用于完整流程的审查画像核对；只读一次。
    const triage = triageOf(root, item.slug);
    // reviewRequired 只对轻量修复有意义：轻量功能始终 review，完整流程也会 review。
    const markerRequired = flow === 'light-bug' ? needsReview(root, item.slug) : false;
    // 显式标记优先于 triage 的跳过结论，避免后续补标记被旧快照覆盖。
    const reviewRequired = flow === 'light-bug'
      ? (markerRequired || (triage ? triage.trigger !== 'skipped' : false))
      : false;
    const triageStale = triage ? triageIsStale(root, item.slug) : false;
    let stage = stageOf(item.files, pending, reviewRequired, item.substantive);
    const fullTrace = traceFor(root, item.slug);
    // review.md 存在时校验内容；有未关闭阻断项或画像缺失时不能判完成。
    const reviewGate = item.files.includes('review.md') && (stage === 'done' || stage === 'review')
      ? checkReviewReport(root, item.slug, { triage, trace: fullTrace })
      : null;
    if (reviewGate && !reviewGate.ok && stage === 'done') stage = 'review';
    const gap = stage === 'review' && item.files.includes('review.md') ? null : GAP[stage];
    const planDrift = changes ? planDriftFor(root, item.slug, { changes }) : null;
    const trace = summarizeTrace(fullTrace);
    const staleArtifacts = staleDownstream(chainOf(flow), item.mtimes).map((entry) => ({
      upstream: entry.upstream,
      downstream: entry.downstream,
      upstreamAt: new Date(entry.upstreamAt).toISOString(),
      downstreamAt: new Date(entry.downstreamAt).toISOString(),
      from: entry.from,
    }));
    // 多组过期只推荐链上最早一条：它归档后的范围自然覆盖后面的过期项。
    const firstStale = staleArtifacts[0] || null;
    const staleCommand = firstStale?.from && validSlug(item.slug)
      ? `devflow change --slug ${item.slug} --from ${firstStale.from}`
      : null;
    return {
      slug: item.slug,
      stage,
      flow,
      reviewRequired,
      trace: trace.skipped ? null : trace,
      reviewTriage: flow === 'light-bug' && triage
        ? { trigger: triage.trigger, level: triage.level ?? null, stale: triageStale }
        : null,
      triageStale,
      staleDownstream: staleArtifacts,
      staleFrom: firstStale?.from ?? null,
      staleCommand,
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
    suggestions.push(`有改动尚未验证；运行 /devflow:test ${activeSlug || '<slug>'}，通过后运行 node scripts/devflow-test.mjs --command "<命令>" --exit-code 0`);
  }
  if (state.lastTestStatus === 'failed') {
    suggestions.push(`上次测试失败（exit ${state.lastTestExitCode ?? '?'}）；修复后重新运行并用 node scripts/devflow-test.mjs --command "<命令>" --exit-code <退出码> 记录结果`);
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
    if (row.trace && row.trace.gaps > 0 && row.stage !== 'done') {
      const ids = row.trace.gapIds.slice(0, 3).join('、');
      suggestions.push(`${row.slug}：验收跟踪 ${row.trace.covered}/${row.trace.total} 已覆盖，缺口 ${ids}${row.trace.gapIds.length > 3 ? ' 等' : ''}；补齐证据或运行 devflow trace --slug ${row.slug} --check`);
    }
  }
  for (const row of rows) {
    if (row.reviewGate && !row.reviewGate.ok) {
      suggestions.push(`${row.slug}：审查报告未通过门禁（${row.reviewGate.errors[0]}）；运行 /devflow:review ${row.slug} 补全后重跑 devflow status`);
    }
  }
  for (const row of rows) {
    if (!row.staleCommand) continue;
    const first = row.staleDownstream[0];
    const more = row.staleDownstream.length > 1 ? `（另有 ${row.staleDownstream.length - 1} 项过期关系）` : '';
    suggestions.push(`${row.slug}：${first.upstream} 晚于 ${first.downstream}，下游证据可能过期${more}；预览归档：${row.staleCommand}（确认后加 --apply）`);
  }
  for (const group of duplicates) {
    suggestions.push(`疑似重复任务：${group.slugs.join('、')} 的标题相同（${group.title}）；确认是否应合并到一个 slug，避免维护两套产物`);
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
    initialized,
    activeSlug,
    inferred: Boolean(activeSlug && !wanted),
    slugs: rows,
    archived: scanArchived(root),
    duplicates,
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
  warnUnknownArgs(argv, ['--root', '--json', '--slug']);
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const wanted = argValue(argv, '--slug', null);

  const result = buildStatus(root, { wanted });
  if (result.missing) {
    console.error(`[ERR] 未找到任务：${wanted}（查找 docs/devflow/${wanted}/）`);
    process.exitCode = 1;
    return null;
  }
  if (result.archived) {
    console.error(`[ERR] 任务已归档：${wanted}（查看 docs/devflow/${wanted}/.archive/；重新开始时运行 /devflow:req ${wanted}）`);
    process.exitCode = 1;
    return null;
  }
  const { report } = result;

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`devflow 状态（根：${report.root}）`);
  // 三态首屏：未初始化只给入口引导，不展开路由与建议这类初始化后才有的信息。
  if (!report.initialized && !report.slugs.length) {
    console.log('  尚未初始化：运行 /devflow:init 创建工作区（.claude/hub、投影与规则草稿）。');
    console.log('  新功能：/devflow:req <需求>（小改动加 --light）');
    console.log('  修复缺陷：/devflow:debug <问题描述>');
    return report;
  }
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
      const stale = row.triageStale ? '，triage 可能过期，建议重跑' : '';
      const gate = row.reviewGate && !row.reviewGate.ok ? '，审查报告未通过门禁' : '';
      const gap = row.gap ? `（缺少 ${row.gap}）` : '';
      console.log(`  ${row.slug}`);
      console.log(`    阶段：${row.stage}${flow}${review}${triage}${stale}${gate}`);
      console.log(`    产物：${produced}${gap}`);
      if (row.trace && row.trace.gaps > 0 && row.stage !== 'done') {
        const ids = row.trace.gapIds.slice(0, 3).join('、');
        const more = row.trace.gapIds.length > 3 ? ' 等' : '';
        console.log(`    验收跟踪：${row.trace.covered}/${row.trace.total} 已覆盖，缺口 ${ids}${more}`);
      }
      const staleItems = row.staleDownstream || [];
      if (staleItems.length) {
        const first = staleItems[0];
        console.log(`    下游可能过期：${first.upstream} 晚于 ${first.downstream}`);
        if (row.staleCommand) {
          console.log(`    预览归档：${row.staleCommand}（确认后加 --apply）`);
        }
        if (staleItems.length > 1) {
          console.log(`    另有 ${staleItems.length - 1} 项过期关系，按最早起点归档即可覆盖`);
        }
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
  if (report.duplicates.length) {
    for (const group of report.duplicates.slice(0, 2)) {
      console.log(`  疑似重复任务：${group.slugs.join('、')}（标题：${group.title}）；确认是否合并到一个 slug`);
    }
    if (report.duplicates.length > 2) {
      console.log(`  疑似重复任务：另有 ${report.duplicates.length - 2} 组`);
    }
  }
  if (report.archived.length) {
    console.log(`  已归档任务：${report.archived.join('、')}（运行 /devflow:req <slug> 重新开始）`);
  }
  // 未配置路由时只保留一行入口，避免和下方“提示”重复。
  if (report.routing.configured) {
    const tools = report.routing.availableTools.length
      ? report.routing.availableTools.join('、')
      : '无（运行 devflow route --detect 更新）';
    console.log(`  路由：${report.routing.mode}；可用工具：${tools}`);
  } else {
    console.log('  路由：未配置（运行 /devflow:init 可启用工具路由）');
  }
  if (report.state.lastTest) {
    const test = report.state.lastTest;
    console.log(`  最近测试：${test.status}${test.exitCode !== null ? `（exit ${test.exitCode}）` : ''}${test.durationMs !== null ? `，${test.durationMs}ms` : ''}`);
  }
  const visibleSuggestions = report.suggestions.filter((s) => {
    if (!report.slugs.length && s.startsWith('未发现进行中的任务')) return false;
    // 路由未配置时已由上面一行说明，不再重复提示。
    if (!report.routing.configured && s.includes('ecosystem.yaml')) return false;
    // 过期关系已在任务行内连同命令展示，底部不再重复。
    if (s.includes('下游证据可能过期')) return false;
    return true;
  });
  for (const item of visibleSuggestions) console.log(`  提示：${item}`);
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
