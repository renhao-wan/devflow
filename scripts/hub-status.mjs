#!/usr/bin/env node
// 只读进度视图：扫描 docs/devflow/<slug>/ 的产物与 .devflow-state.json，
// 推导每个任务所处阶段并给出下一步命令；不写入任何状态。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readText, isMain, projectRoot, argValue, hasFlag, posix } from './lib/common.mjs';
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

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const wanted = argValue(argv, '--slug', null);
  const state = readState(root);

  let slugs = scanSlugs(root);
  if (wanted) {
    slugs = slugs.filter((s) => s.slug === wanted);
    if (!slugs.length) {
      console.error(`[ERR] 未找到任务：${wanted}（查找 docs/devflow/${wanted}/）`);
      process.exitCode = 1;
      return null;
    }
  }

  // 只有一个任务（或显式指定）时，才能把全局 testsPending 归到它名下。
  const activeSlug = wanted || (slugs.length === 1 ? slugs[0].slug : null);
  const testsPending = Boolean(state.testsPending);
  const rows = slugs.map((item) => {
    const pending = testsPending && item.slug === activeSlug;
    const flow = flowOf(item.files);
    // reviewRequired 只对轻量修复有意义：轻量功能始终 review，完整流程也会 review。
    const reviewRequired = flow === 'light-bug' && needsReview(root, item.slug);
    const stage = stageOf(item.files, pending, reviewRequired);
    return {
      slug: item.slug,
      stage,
      flow,
      reviewRequired,
      artifacts: item.files,
      gap: GAP[stage],
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

  const report = {
    root: posix(root),
    activeSlug,
    inferred: Boolean(activeSlug && !wanted),
    slugs: rows,
    state: { testsPending, hubPending: Boolean(state.hubPending) },
    routing: {
      configured: eco.exists,
      mode: eco.config.routing.mode,
      availableTools,
      stale,
    },
    suggestions,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`devflow 状态（根：${report.root}）`);
  if (!rows.length) {
    console.log('  未发现 docs/devflow/ 下的任务。');
  } else {
    for (const row of rows) {
      const produced = row.artifacts.length ? row.artifacts.join(', ') : '（无）';
      const flow = FLOW_LABEL[row.flow] ? `  模式：${FLOW_LABEL[row.flow]}` : '';
      const review = row.reviewRequired && row.stage !== 'done' ? '，需补审查' : '';
      const gap = row.gap ? `，缺少 ${row.gap}` : '';
      console.log(`  ${row.slug}  阶段：${row.stage}${flow}${review}  产物：${produced}${gap}`);
      console.log(`    下一步：${row.next}`);
    }
    if (activeSlug && !wanted && slugs.length === 1) {
      console.log(`  未传 --slug 时默认使用：${activeSlug}`);
    }
  }
  const tools = report.routing.availableTools.length
    ? report.routing.availableTools.join('、')
    : '无（运行 devflow route --detect 更新）';
  console.log(`  路由：${report.routing.mode}${report.routing.configured ? '' : '（未配置）'}；可用工具：${tools}`);
  for (const item of suggestions) console.log(`  提示：${item}`);
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
