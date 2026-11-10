#!/usr/bin/env node
// 清理当前工作区的 devflow 产物：默认只预览，--apply 才执行。
// 删除项先 rename 到 .claude/.devflow-trash，失败逆序回滚；hub 与任务记录需显式开关。
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  argValue, hasFlag, warnUnknownArgs, isMain, samePath, posix,
  isPathInside, isRealPathInside, ensureDir, readText, writeText,
} from './lib/common.mjs';
import {
  DEFAULT_ARTIFACTS, OPTIONAL_ARTIFACTS, PRESERVED_ARTIFACTS, HUB_DIR, DOCS_DIR,
} from './lib/managed-artifacts.mjs';

const ANCHORS = ['.claude/hub/hub.yaml', '.devflow.json'];
const DEVFLOW_BLOCK = /# >>> devflow[^\n]*\n[\s\S]*?# <<< devflow\n?/;

export const defaultOps = {
  exists: existsSync,
  readdir: readdirSync,
  rename: renameSync,
  ensureDir,
  readText,
  writeText,
};

function hasProjection(dir, ops) {
  const skills = join(dir, '.claude', 'skills');
  if (!ops.exists(skills)) return false;
  try {
    return ops.readdir(skills).some((name) => name.startsWith('devflow-'));
  } catch {
    return false;
  }
}

/** 锚点缺失时仍允许清理残留投影；全都没有则返回 null，绝不按 cwd 猜路径。 */
function findRoot(start, ops = defaultOps) {
  let dir = resolve(start);
  while (true) {
    if (ANCHORS.some((rel) => ops.exists(join(dir, ...rel.split('/'))))) return dir;
    if (hasProjection(dir, ops)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function assertSafeRoot(root) {
  if (samePath(root, parse(root).root)) throw new Error('拒绝清理文件系统根目录');
  if (samePath(root, homedir())) throw new Error('拒绝清理用户主目录');
  if (!existsSync(join(root, '.claude'))) throw new Error('目录中没有 .claude/，不像是 devflow 工作区');
}

function assertInside(root, abs) {
  if (!isPathInside(root, abs) || !isRealPathInside(root, abs)) {
    throw new Error(`删除目标越界（可能被 junction/符号链接引到项目外）：${posix(abs)}`);
  }
}

function projectionDirs(root, ops) {
  const dir = join(root, '.claude', 'skills');
  if (!ops.exists(dir)) return [];
  try {
    return ops.readdir(dir)
      .filter((name) => name.startsWith('devflow-'))
      .map((name) => `.claude/skills/${name}`);
  } catch {
    return [];
  }
}

/** 只返回真实存在的项；越界目标在删除任何文件之前就报错。 */
function expandPaths(root, flags, ops) {
  const rels = [];
  for (const rel of DEFAULT_ARTIFACTS) {
    if (rel === '.claude/skills/devflow-*') rels.push(...projectionDirs(root, ops));
    else rels.push(rel);
  }
  if (flags.hub) rels.push(...OPTIONAL_ARTIFACTS.hub);
  if (flags.docs) rels.push(...OPTIONAL_ARTIFACTS.docs);
  return [...new Set(rels)].filter((rel) => {
    const abs = join(root, ...rel.split('/'));
    if (!ops.exists(abs)) return false;
    assertInside(root, abs);
    return true;
  });
}

function preservedFor(root, flags, ops) {
  const items = [];
  for (const rel of PRESERVED_ARTIFACTS) {
    if (!ops.exists(join(root, ...rel.split('/')))) continue;
    items.push({ rel, why: rel.includes('trash') ? '备份，始终保留' : '审计记录，始终保留' });
  }
  if (!flags.hub && ops.exists(join(root, ...HUB_DIR.split('/')))) {
    items.push({ rel: HUB_DIR, why: '项目真源，加 --hub 删除' });
  }
  if (!flags.docs && ops.exists(join(root, ...DOCS_DIR.split('/')))) {
    items.push({ rel: DOCS_DIR, why: '任务记录，加 --docs 删除' });
  }
  return items;
}

function applyPlan(root, rels, ops) {
  const trash = join(root, '.claude', '.devflow-trash', String(Date.now()));
  const gitignore = join(root, '.gitignore');
  const before = ops.exists(gitignore) ? ops.readText(gitignore) : null;
  const removeBlock = before !== null && DEVFLOW_BLOCK.test(before);
  const moved = [];
  ops.ensureDir(trash);
  try {
    for (const rel of rels) {
      const from = join(root, ...rel.split('/'));
      const to = join(trash, ...rel.split('/'));
      ops.ensureDir(dirname(to));
      ops.rename(from, to);
      moved.push({ from, to });
    }
    if (removeBlock) {
      // .gitignore 是原地改写，不在 rename 回滚范围内，先留一份原文到 trash。
      ops.writeText(join(trash, '.gitignore.before'), before);
      ops.writeText(gitignore, before.replace(DEVFLOW_BLOCK, ''));
    }
  } catch (err) {
    const errors = [];
    for (let i = moved.length - 1; i >= 0; i -= 1) {
      const { from, to } = moved[i];
      try {
        ops.ensureDir(dirname(from));
        ops.rename(to, from);
      } catch (rollbackErr) {
        errors.push(rollbackErr.message);
      }
    }
    if (removeBlock) {
      try {
        ops.writeText(gitignore, before);
      } catch (rollbackErr) {
        errors.push(rollbackErr.message);
      }
    }
    if (errors.length) {
      throw new Error(`${err.message}；回滚未完全成功：${errors.join('；')}；备份保留在 ${posix(trash)}`);
    }
    throw err;
  }
  return { trash, removed: moved.length, gitignore: removeBlock };
}

function renderPreview(out, root, rels, preserved, removeBlock) {
  out('[INFO] devflow clean：预览模式（加 --apply 执行）');
  out(`[INFO] 项目根：${posix(root)}`);
  out(`[INFO] 将删除 ${rels.length} 项：`);
  if (rels.length) for (const rel of rels) out(`  - ${rel}`);
  else out('  （无）');
  out('[INFO] 将保留：');
  if (preserved.length) for (const item of preserved) out(`  - ${item.rel}（${item.why}）`);
  else out('  （无）');
  if (removeBlock) out('[INFO] 将移除 .gitignore 中的 devflow 标记块');
}

export function runClean({ root, flags = {}, ops = defaultOps, out = console.log } = {}) {
  const target = resolve(root);
  assertSafeRoot(target);
  const wanted = { hub: flags.hub === true || flags.all === true, docs: flags.docs === true || flags.all === true };
  const rels = expandPaths(target, wanted, ops);
  const preserved = preservedFor(target, wanted, ops);
  const gitignore = join(target, '.gitignore');
  const before = ops.exists(gitignore) ? ops.readText(gitignore) : '';
  const removeBlock = before !== '' && DEVFLOW_BLOCK.test(before);
  const report = {
    root: posix(target),
    mode: flags.apply ? 'apply' : 'preview',
    delete: rels,
    keep: preserved.map((item) => item.rel),
    gitignore: removeBlock,
    applied: false,
  };
  if (!flags.apply) {
    renderPreview(out, target, rels, preserved, removeBlock);
    return report;
  }
  if (!rels.length && !removeBlock) {
    out('[OK] 没有可删除的产物，devflow 已从该项目移除。');
    report.applied = true;
    return report;
  }
  const result = applyPlan(target, rels, ops);
  report.applied = true;
  report.trash = posix(result.trash);
  out(`[OK] 已删除 ${result.removed} 项`);
  if (result.gitignore) out('[OK] 已移除 .gitignore 中的 devflow 标记块');
  out(`[INFO] 备份保留在 ${posix(result.trash)}；确认后手动删除，它会出现在 git status`);
  out('[OK] 清理完成');
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, ['--root', '--apply', '--hub', '--docs', '--all', '--json', '--dry-run']);
  const json = hasFlag(argv, '--json');
  const start = argValue(argv, '--root', null) || process.cwd();
  const root = findRoot(start);
  if (!root) {
    if (json) console.log(JSON.stringify({ found: false, applied: false, delete: [], keep: [] }, null, 2));
    else console.log('[OK] 未发现 devflow 工作区，无需清理。');
    return { found: false };
  }
  const lines = [];
  const report = runClean({
    root,
    flags: {
      apply: hasFlag(argv, '--apply'),
      hub: hasFlag(argv, '--hub'),
      docs: hasFlag(argv, '--docs'),
      all: hasFlag(argv, '--all'),
    },
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
