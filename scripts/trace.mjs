#!/usr/bin/env node
// 验收追踪：devflow trace [--slug <slug>] [--check] [--json]
// 默认只读；--check 时存在未覆盖验收项才返回退出码 1。
import { argValue, hasFlag, isMain, projectRoot } from './lib/common.mjs';
import { MISSING, resolveSlug } from './lib/slug.mjs';
import { traceFor } from './lib/trace.mjs';

const SOURCE_LABELS = { req: 'req.md', brief: 'brief.md', debug: 'debug.md' };

function evidenceLine(item) {
  const parts = [];
  parts.push(item.plan.length ? `plan×${item.plan.length}` : '无 plan 映射');
  if (item.test) parts.push(item.test.covered ? 'test 通过' : `test ${item.test.result || '无结论'}`);
  else parts.push('无 test 证据');
  if (item.review) parts.push(`review ${item.review.raw || item.review.status || '无结论'}`);
  else parts.push('无 review 结论');
  return parts.join('，');
}

function render(result, { check }) {
  if (result.skipped) {
    // --check 下无法追踪等同于没有通过校验，不能只给 WARN 却返回成功。
    const marker = check ? 'ERR' : 'WARN';
    console.log(`[${marker}] ${result.slug}：${result.reason}`);
    return;
  }
  console.log(`[TRACE] ${result.slug} · ${SOURCE_LABELS[result.source] || result.source}（${result.flow}）`);
  for (const item of result.items) {
    const marker = item.status === 'covered' || item.status === 'accepted' ? 'OK' : 'WARN';
    console.log(`[${marker}] ${item.id} ${item.text}（${item.status}）`);
    console.log(`       ${evidenceLine(item)}`);
  }
  for (const warning of result.warnings) console.log(`[WARN] ${warning}`);
  const { totals } = result;
  console.log(
    `汇总：${totals.items} 项，已覆盖 ${totals.covered}，已接受 ${totals.accepted}，`
    + `缺口 ${totals.gaps}${result.missing.length ? `（${result.missing.join('、')}）` : ''}`,
  );
  if (totals.gaps === 0) {
    console.log('[OK] 所有验收项都有实现/测试支撑或已被显式接受');
  } else if (check) {
    console.log(`[ERR] ${totals.gaps} 项验收缺少实现/测试支撑`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const check = hasFlag(argv, '--check');
  const wanted = argValue(argv, '--slug', null);

  const slug = resolveSlug(root, wanted);
  if (slug === MISSING) {
    console.error(`[ERR] 未找到任务：${wanted}（查找 docs/devflow/${wanted}/）`);
    process.exitCode = 1;
    return null;
  }

  const result = traceFor(root, slug);
  if (json) console.log(JSON.stringify(result, null, 2));
  else render(result, { check });

  // 已知流程但无法追踪（缺少验收来源等）同样视为校验失败；只有缺口为 0 才算通过。
  if (check && (result.flow === 'unknown' || result.skipped || result.totals.gaps > 0)) {
    process.exitCode = 1;
  }
  return result;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exitCode = 1;
  }
}
