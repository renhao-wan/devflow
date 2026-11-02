#!/usr/bin/env node
// 可选 statusline：复用 hub-status 的只读推导，输出一行紧凑进度；失败时静默降级。
import { argValue, hasFlag, projectRoot } from './lib/common.mjs';
import { buildStatus } from './hub-status.mjs';

const FLOW_LABEL = {
  'light-feature': '轻量功能',
  'light-bug': '轻量修复',
};

function readInput(timeoutMs = 400) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function rootFrom(input, argv) {
  const explicit = argValue(argv, '--root', null);
  if (explicit) return explicit;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  return input?.workspace?.current_dir || input?.cwd || input?.workspace?.project_dir || projectRoot();
}

function summarize(report) {
  if (!report?.slugs?.length) return 'devflow · 无进行中任务';
  if (!report.activeSlug && report.slugs.length > 1) return `devflow · ${report.slugs.length} 个任务`;
  const active = report.slugs.find((row) => row.slug === report.activeSlug) || report.slugs[0];
  const parts = [active.slug, active.stage];
  if (FLOW_LABEL[active.flow]) parts.push(FLOW_LABEL[active.flow]);
  if (report.state?.testsPending) parts.push('待测试');
  if (active.reviewRequired && active.stage !== 'done') parts.push('需补审查');
  if (report.state?.hubPending) parts.push('投影待生成');
  return `devflow · ${parts.join(' · ')}`;
}

function compact(report) {
  const active = report?.slugs?.find((row) => row.slug === report.activeSlug) || report?.slugs?.[0] || null;
  return {
    slug: active?.slug || null,
    stage: active?.stage || null,
    flow: active?.flow || null,
    count: report?.slugs?.length || 0,
    testsPending: Boolean(report?.state?.testsPending),
    reviewRequired: Boolean(active?.reviewRequired),
    hubPending: Boolean(report?.state?.hubPending),
  };
}

try {
  const argv = process.argv.slice(2);
  const input = await readInput();
  const { report } = buildStatus(rootFrom(input, argv), {});
  if (hasFlag(argv, '--json')) {
    process.stdout.write(`${JSON.stringify(compact(report))}\n`);
  } else {
    const line = summarize(report).replace(/[\r\n]+/g, ' ').slice(0, 80);
    process.stdout.write(`${line}\n`);
  }
} catch {
  // statusline 失败不能影响提示符；保持单行且不输出路径或错误细节。
  process.stdout.write('devflow · 状态不可用\n');
}
process.exit(0);
