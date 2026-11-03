#!/usr/bin/env node
// 阶段产物门禁：devflow check --stage req|debug [--slug <slug>] [--json]
// 只校验结构是否完整；未通过时退出码为 1。
import { argValue, hasFlag, isMain, projectRoot } from './lib/common.mjs';
import { MISSING, resolveSlug } from './lib/slug.mjs';
import { checkStage } from './lib/stage-gate.mjs';

export function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const stage = argValue(argv, '--stage', null);
  if (!stage) throw new Error('--stage 必填，可选 req、debug');
  if (!['req', 'debug'].includes(stage)) throw new Error(`未知阶段：${stage}；可选 req、debug`);

  const wanted = argValue(argv, '--slug', null);
  const slug = resolveSlug(root, wanted);
  if (slug === MISSING) {
    console.error(`[ERR] 未找到任务：${wanted}（查找 docs/devflow/${wanted}/）`);
    process.exitCode = 1;
    return null;
  }

  const result = checkStage(root, slug, stage);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`阶段门禁（${stage}，slug：${slug}）`);
    for (const error of result.errors) console.log(`[ERR] ${error}`);
    for (const warning of result.warnings) console.log(`[WARN] ${warning}`);
    if (result.ok) console.log('[OK] 产物已满足结构要求');
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (isMain(import.meta.url)) {
  main();
}
