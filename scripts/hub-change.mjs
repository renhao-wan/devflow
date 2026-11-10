#!/usr/bin/env node
// 重开阶段：把指定阶段及其下游产物归档到 docs/devflow/<slug>/.archive/。
// 默认只预览，--apply 才移动；不写任何阶段状态，回退后的阶段仍由产物存在性推导。
import { existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  argValue, hasFlag, warnUnknownArgs, isMain, posix,
  isPathInside, isRealPathInside, readText, writeText,
} from './lib/common.mjs';
import { resolveSlug, validSlug, MISSING } from './lib/slug.mjs';
import {
  ARTIFACTS, flowOf, archivePlanFor, startFileFor, normalizeFrom,
} from './lib/artifact-chain.mjs';

export const defaultOps = {
  exists: existsSync,
  mkdir: mkdirSync,
  rename: renameSync,
  rmdir: rmdirSync,
  unlink: unlinkSync,
  readText,
  writeText,
};

const STAMP_LIMIT = 100;

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** 本地时间戳，便于用户直接看出归档时间；manifest 里另存 UTC ISO。 */
export function formatStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`;
}

function assertInside(root, abs, what) {
  if (!isPathInside(root, abs) || !isRealPathInside(root, abs)) {
    throw new Error(`${what}越界（可能被 junction/符号链接引到项目外）：${posix(abs)}`);
  }
}

function pickArchiveDir(base, stamp, ops, { create = false } = {}) {
  if (create) ops.mkdir(base, { recursive: true });
  for (let i = 0; i < STAMP_LIMIT; i += 1) {
    const name = i === 0 ? stamp : `${stamp}-${i}`;
    const dir = join(base, name);
    if (!create) {
      if (!ops.exists(dir)) return { name, dir };
      continue;
    }
    try {
      // 非递归 mkdir 是原子占位：并发或重名时 EEXIST，换下一个序号，不覆盖已有归档。
      ops.mkdir(dir);
      return { name, dir };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`无法在 ${posix(base)} 下创建归档目录（同名目录过多）`);
}

function rollback(moved, archiveDir, manifestFile, ops) {
  const errors = [];
  for (let i = moved.length - 1; i >= 0; i -= 1) {
    const { from, to } = moved[i];
    try {
      ops.rename(to, from);
    } catch (err) {
      errors.push(err.message);
    }
  }
  try {
    if (ops.exists(manifestFile)) ops.unlink(manifestFile);
  } catch (err) {
    errors.push(err.message);
  }
  try {
    // 只删本次创建的空目录：并发写入时保留目录，避免误删他人文件。
    ops.rmdir(archiveDir);
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(err.message);
  }
  return errors;
}

function nextStep(plan, slug) {
  if (plan.stage === 'req') {
    if (plan.flow === 'light-feature') return `修改 brief.md 后运行 /devflow:implement ${slug}`;
    if (plan.flow === 'light-bug') return `修改 debug.md 后运行 /devflow:test ${slug}`;
    return `修改 req.md 后运行 /devflow:plan ${slug}`;
  }
  if (plan.stage === 'plan') {
    return `修改 plan.md 后运行 /devflow:implement ${slug}；实现无需变化时直接运行 /devflow:test ${slug}`;
  }
  if (plan.stage === 'test') return `运行 /devflow:test ${slug} 重新生成测试记录`;
  return `运行 /devflow:review ${slug} 重新审查`;
}

function render(out, report, { apply }) {
  if (!apply) {
    out('[INFO] devflow change：预览模式（加 --apply 执行）');
  }
  out(`[INFO] 任务：${report.slug}（流程：${report.flow}）`);
  out(`[INFO] 回退到：${report.from}${report.purge ? '（含该阶段自身）' : ''}`);
  if (report.noop) {
    out('[OK] 没有可归档的产物，无需归档。');
    if (apply) out(`[INFO] 下一步：${report.next}`);
    return;
  }
  out(`[INFO] ${apply ? '已归档' : '将归档'} ${report.files.length} 项到 ${report.archiveDir}：`);
  for (const rel of report.files) out(`  - ${rel}`);
  out(`[INFO] 保留：${report.keep.length ? report.keep.join('、') : '（无）'}`);
  if (apply) {
    out('[OK] 归档完成');
    out('[INFO] 归档目录默认由 .gitignore 忽略；需要保留时用 git add -f，旧项目重跑 /devflow:init 生效');
    if (report.unrecognized) {
      out('[WARN] 任务目录已无入口产物，将不再出现在 devflow status；重新开始时运行 /devflow:req <slug>');
    }
  }
  out(`[INFO] 下一步：${report.next}`);
}

/**
 * 执行一次 change（预览或归档）。
 * root/slug 由调用方给出；from 支持 req|plan|test|review，brief/debug 作为 req 的别名。
 */
export function runChange({
  root, slug, from, purge = false, apply = false, ops = defaultOps, out = console.log, now = () => new Date(),
} = {}) {
  const target = resolve(root);
  if (!validSlug(slug)) throw new Error(`非法的 slug：${slug}`);
  const dir = join(target, 'docs', 'devflow', slug);
  if (!ops.exists(dir)) throw new Error(`未找到任务：${slug}（查找 docs/devflow/${slug}/）`);
  assertInside(target, dir, '任务目录');

  const files = ARTIFACTS.filter((name) => ops.exists(join(dir, name)));
  const flow = flowOf(files);
  const plan = archivePlanFor(flow, from, { purge });
  if (plan.error) throw new Error(plan.error);

  const required = plan.stage === 'req' ? startFileFor(flow) : `${plan.stage}.md`;
  if (!required || !ops.exists(join(dir, required))) {
    throw new Error(`没有可回退的 ${required || plan.stage}；当前流程为 ${flow}`);
  }

  const existing = plan.files.filter((name) => ops.exists(join(dir, name)));
  const keep = plan.keep.filter((name) => ops.exists(join(dir, name)));
  const at = now();
  const stamp = formatStamp(at);
  const archiveBase = join(dir, '.archive');
  assertInside(dir, archiveBase, '归档目录');

  const report = {
    root: posix(target),
    slug,
    flow,
    from: plan.stage,
    purge: Boolean(purge),
    mode: apply ? 'apply' : 'preview',
    files: existing,
    keep,
    archiveDir: null,
    applied: false,
    noop: false,
    next: nextStep(plan, slug),
    unrecognized: Boolean(purge && (plan.stage === 'req' || plan.stage === 'plan') && !keep.length),
  };

  if (!existing.length) {
    report.noop = true;
    report.applied = apply;
    render(out, report, { apply });
    return report;
  }

  if (!apply) {
    const picked = pickArchiveDir(archiveBase, stamp, ops);
    report.archiveDir = posix(relative(target, picked.dir));
    render(out, report, { apply: false });
    return report;
  }

  if (purge && (plan.stage === 'test' || plan.stage === 'review')) {
    out('[WARN] --purge 对 test/review 无效：默认已归档该阶段自身');
  }

  const picked = pickArchiveDir(archiveBase, stamp, ops, { create: true });
  report.archiveDir = posix(relative(target, picked.dir));
  const moved = [];
  const manifestFile = join(picked.dir, 'manifest.json');
  try {
    for (const name of existing) {
      const fromFile = join(dir, name);
      const toFile = join(picked.dir, name);
      assertInside(dir, fromFile, '归档源');
      assertInside(dir, toFile, '归档目标');
      ops.rename(fromFile, toFile);
      moved.push({ from: fromFile, to: toFile });
    }
    ops.writeText(manifestFile, `${JSON.stringify({
      version: 1,
      slug,
      from: plan.stage,
      purge: Boolean(purge),
      flow,
      createdAt: at.toISOString(),
      files: existing,
    }, null, 2)}\n`);
  } catch (err) {
    const errors = rollback(moved, picked.dir, manifestFile, ops);
    if (errors.length) {
      throw new Error(`${err.message}；回滚未完全成功：${errors.join('；')}；归档目录保留在 ${posix(picked.dir)}`);
    }
    throw err;
  }

  report.applied = true;
  render(out, report, { apply: true });
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, ['--root', '--slug', '--from', '--purge', '--apply', '--dry-run', '--json']);
  const json = hasFlag(argv, '--json');
  const apply = hasFlag(argv, '--apply');
  if (apply && hasFlag(argv, '--dry-run')) {
    throw new Error('--apply 与 --dry-run 不能同时使用');
  }
  const root = resolve(argValue(argv, '--root', null) || process.cwd());
  const wanted = resolveSlug(root, argValue(argv, '--slug', null));
  if (wanted === MISSING) {
    throw new Error(`未找到任务：${argValue(argv, '--slug', '')}`);
  }
  const from = normalizeFrom(argValue(argv, '--from', ''));
  if (!from) throw new Error('--from 必填，可选 req、plan、test、review');
  const lines = [];
  const report = runChange({
    root,
    slug: wanted,
    from,
    purge: hasFlag(argv, '--purge'),
    apply,
    out: json ? (line) => lines.push(line) : (line) => console.log(line),
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
