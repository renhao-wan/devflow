#!/usr/bin/env node
// 可选 statusline：复用 hub-status 的只读推导，输出一行紧凑进度；失败时静默降级。
import { writeSync } from 'node:fs';
import { argValue, hasFlag, isMain, projectRoot } from './lib/common.mjs';
import { buildStatus } from './hub-status.mjs';

const MAX_WIDTH = 80;
const FLOW_LABEL = {
  'light-feature': '轻量功能',
  'light-bug': '轻量修复',
};

function emit(line) {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    // statusline 输出失败不能影响提示符。
  }
}

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
  const candidate = process.env.CLAUDE_PROJECT_DIR
    || input?.workspace?.current_dir
    || input?.cwd
    || input?.workspace?.project_dir
    || process.cwd();
  return projectRoot(candidate);
}

function formatLine(parts) {
  const line = `devflow · ${parts.join(' · ')}`;
  if (line.length <= MAX_WIDTH) return line;

  const [head, ...rest] = parts;
  const suffix = rest.length ? ` · ${rest.join(' · ')}` : '';
  const room = Math.max(1, MAX_WIDTH - 'devflow · '.length - suffix.length - 1);
  const shortened = head.length > room ? `${head.slice(0, room)}…` : head;
  const result = `devflow · ${shortened}${suffix}`;
  return result.length > MAX_WIDTH ? `${result.slice(0, MAX_WIDTH - 1)}…` : result;
}

function summarize(report) {
  if (!report?.slugs?.length) return 'devflow · 无进行中任务';
  if (!report.activeSlug && report.slugs.length > 1) {
    const parts = [`${report.slugs.length} 个任务`];
    if (report.state?.testsPending) parts.push('待测试');
    if (report.state?.hubPending) parts.push('投影待生成');
    return formatLine(parts);
  }

  const active = report.slugs.find((row) => row.slug === report.activeSlug) || report.slugs[0];
  const parts = [active.slug, active.stage];
  if (FLOW_LABEL[active.flow]) parts.push(FLOW_LABEL[active.flow]);
  if (report.state?.testsPending) parts.push('待测试');
  if (active.reviewRequired && active.stage !== 'done') parts.push('需补审查');
  if (report.state?.hubPending) parts.push('投影待生成');
  return formatLine(parts);
}

function compact(report) {
  const rows = report?.slugs || [];
  const active = report?.activeSlug
    ? rows.find((row) => row.slug === report.activeSlug)
    : null;
  return {
    activeSlug: report?.activeSlug || null,
    slug: active?.slug ?? null,
    stage: active?.stage ?? null,
    flow: active?.flow ?? null,
    count: rows.length,
    testsPending: Boolean(report?.state?.testsPending),
    reviewRequired: Boolean(active?.reviewRequired),
    hubPending: Boolean(report?.state?.hubPending),
    slugs: rows.map((row) => ({
      slug: row.slug,
      stage: row.stage,
      flow: row.flow,
      reviewRequired: Boolean(row.reviewRequired),
    })),
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const input = await readInput();
    const { report } = buildStatus(rootFrom(input, argv), { drift: false });
    if (hasFlag(argv, '--json')) {
      emit(JSON.stringify(compact(report)));
    } else {
      emit(summarize(report).replace(/[\r\n]+/g, ' '));
    }
  } catch {
    // statusline 失败不能影响提示符；保持单行且不输出路径或错误细节。
    emit('devflow · 状态不可用');
  }
}

if (isMain(import.meta.url)) {
  await main();
  process.exit(0);
}
