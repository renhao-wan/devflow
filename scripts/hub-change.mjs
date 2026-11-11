#!/usr/bin/env node
// 重开阶段：把指定阶段及其下游产物归档到 docs/devflow/<slug>/.archive/。
// 默认只预览，--apply 才移动；不写任何阶段状态，回退后的阶段仍由产物存在性推导。
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  argValue, hasFlag, hasOption, warnUnknownArgs, isMain, posix,
  isPathInside, isRealPathInside, readText, writeText, writeAtomic,
  withFileLock, projectRoot,
} from './lib/common.mjs';
import { resolveSlug, validSlug, MISSING } from './lib/slug.mjs';
import {
  ARTIFACTS, ENTRY_ARTIFACTS, flowOf, archivePlanFor, startFileFor, normalizeFrom, purgeRemainder,
} from './lib/artifact-chain.mjs';

export const defaultOps = {
  exists: existsSync,
  mkdir: mkdirSync,
  rename: renameSync,
  rmdir: rmdirSync,
  unlink: unlinkSync,
  readText,
  writeText,
  writeAtomic,
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
  // --purge 连同起点文档一起归档时，不能再提示“修改 x.md”；应重新生成该阶段。
  if (plan.selfArchived && (plan.stage === 'req' || plan.stage === 'plan')) {
    if (plan.stage === 'plan') return `/devflow:plan ${slug} 重新生成 plan.md`;
    if (plan.flow === 'light-feature') return `/devflow:req --light ${slug} 重新生成 brief.md`;
    if (plan.flow === 'light-bug') return `/devflow:debug ${slug} 重新生成 debug.md`;
    return `/devflow:req ${slug} 重新生成 req.md`;
  }
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

  const at = now();
  const stamp = formatStamp(at);
  const archiveBase = join(dir, '.archive');
  assertInside(dir, archiveBase, '归档目录');
  // --purge 从链首重开时把其他流程的残留入口产物也归档，避免任务“复活”；
  // keep 为空才扩展，--from plan 等仍保留上游产物。
  const planned = [...new Set([...plan.files, ...purgeRemainder(files, plan.keep)])];
  const collect = () => {
    const existing = planned.filter((name) => ops.exists(join(dir, name)));
    const keep = plan.keep.filter((name) => ops.exists(join(dir, name)));
    const archived = new Set(existing);
    const remainingEntries = ENTRY_ARTIFACTS.filter((name) => !archived.has(name) && ops.exists(join(dir, name)));
    return {
      existing,
      keep,
      // 以归档后的实际剩余入口产物判断，而不是只看 --purge 参数。
      unrecognized: existing.length > 0 && remainingEntries.length === 0,
    };
  };

  const report = {
    root: posix(target),
    slug,
    flow,
    from: plan.stage,
    purge: Boolean(purge),
    mode: apply ? 'apply' : 'preview',
    files: [],
    keep: [],
    archiveDir: null,
    applied: false,
    noop: false,
    next: nextStep(plan, slug),
    unrecognized: false,
  };

  const preview = () => {
    const state = collect();
    report.files = state.existing;
    report.keep = state.keep;
    report.unrecognized = state.unrecognized;
    if (!state.existing.length) {
      report.noop = true;
      render(out, report, { apply: false });
      return report;
    }
    const picked = pickArchiveDir(archiveBase, stamp, ops);
    report.archiveDir = posix(relative(target, picked.dir));
    render(out, report, { apply: false });
    return report;
  };

  if (!apply) return preview();

  // 扫描与移动都放在任务锁内，避免并发 change/restore 把同一批产物拆到不同归档。
  return withFileLock(join(dir, '.change'), () => {
    const state = collect();
    report.files = state.existing;
    report.keep = state.keep;
    report.unrecognized = state.unrecognized;
    if (!state.existing.length) {
      report.noop = true;
      report.applied = true;
      render(out, report, { apply: true });
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
      for (const name of state.existing) {
        const fromFile = join(dir, name);
        const toFile = join(picked.dir, name);
        assertInside(dir, fromFile, '归档源');
        assertInside(dir, toFile, '归档目标');
        ops.rename(fromFile, toFile);
        moved.push({ from: fromFile, to: toFile });
      }
      // 原子写入：先移动后 manifest 中断时，不留下半截 JSON 让归档无法恢复。
      ops.writeAtomic(manifestFile, `${JSON.stringify({
        version: 1,
        slug,
        from: plan.stage,
        purge: Boolean(purge),
        flow,
        createdAt: at.toISOString(),
        files: state.existing,
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
  }, { failClosed: true, timeoutMs: 5000 });
}

/** 归档目录名格式：YYYYMMDD-HHMMSS-mmm，重名时追加 -N。 */
const ARCHIVE_NAME = /^\d{8}-\d{6}-\d{3}(?:-\d+)?$/;

/** 允许恢复的文件白名单；manifest 里的任何其他名字都拒绝，避免借归档路径读写任意文件。 */
const RESTORABLE = new Set([...ARTIFACTS, 'review-triage.json']);

/** 校验 manifest 并返回去重后的文件清单；未知文件、路径、跨任务归档都直接拒绝。 */
export function validManifestFiles(manifest, slug) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest.json 不是合法对象');
  }
  if (manifest.version !== 1) {
    throw new Error(`不支持的 manifest 版本：${manifest.version ?? '（缺失）'}`);
  }
  if (manifest.slug !== slug) {
    throw new Error(`归档属于任务 ${manifest.slug ?? '（未知）'}，与当前 slug ${slug} 不一致`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('manifest.json 缺少 files 列表');
  }
  const files = [];
  for (const name of manifest.files) {
    if (typeof name !== 'string' || !RESTORABLE.has(name)) {
      throw new Error(`manifest.json 含不允许恢复的文件：${String(name)}`);
    }
    if (!files.includes(name)) files.push(name);
  }
  return files;
}

/** 列出某任务的归档；损坏的 manifest 不阻断其他归档，只在该项标 error。 */
export function listArchives(root, slug) {
  const target = resolve(root);
  if (!validSlug(slug)) throw new Error(`非法的 slug：${slug}`);
  const dir = join(target, 'docs', 'devflow', slug);
  if (!existsSync(dir)) throw new Error(`未找到任务：${slug}（查找 docs/devflow/${slug}/）`);
  assertInside(target, dir, '任务目录');
  const base = join(dir, '.archive');
  if (!existsSync(base)) return { root: posix(target), slug, archives: [] };
  assertInside(dir, base, '归档目录');

  const archives = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ARCHIVE_NAME.test(entry.name))
    .map((entry) => {
      const archiveDir = join(base, entry.name);
      const item = {
        name: entry.name,
        path: posix(relative(target, archiveDir)),
        from: null,
        flow: null,
        purge: false,
        createdAt: null,
        files: [],
        remaining: null,
        error: null,
      };
      const manifestFile = join(archiveDir, 'manifest.json');
      if (!existsSync(manifestFile)) {
        item.error = '缺少 manifest.json';
        return item;
      }
      try {
        const manifest = JSON.parse(readText(manifestFile));
        item.files = validManifestFiles(manifest, slug);
        // 恢复后源文件已不在归档目录，remaining 为 0；仅用于展示，不改变恢复判断。
        item.remaining = item.files.filter((name) => existsSync(join(archiveDir, name))).length;
        item.from = typeof manifest.from === 'string' ? manifest.from : null;
        item.flow = typeof manifest.flow === 'string' ? manifest.flow : null;
        item.purge = Boolean(manifest.purge);
        item.createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt : null;
      } catch (err) {
        item.error = err.message;
      }
      return item;
    })
    // 目录名包含时间戳，降序即最新在前；同毫秒的 -N 后缀也会排在基础名之前。
    .sort((a, b) => b.name.localeCompare(a.name));
  return { root: posix(target), slug, archives };
}

function pickArchive(base, selector, archives) {
  if (selector === 'latest') {
    // “最新”就是目录名最大的一份；即使它损坏也明确报错，不静默回退到更旧的归档。
    if (!archives.length) throw new Error('没有可恢复的归档；运行 devflow change --slug <slug> --list 查看');
    return archives[0];
  }
  // 只接受归档目录名，不接受路径，避免 ../ 或绝对路径逃出 .archive。
  if (!ARCHIVE_NAME.test(String(selector))) {
    throw new Error(`非法的归档名：${selector}（可用 --list 查看）`);
  }
  assertInside(base, join(base, selector), '归档目录');
  const found = archives.find((item) => item.name === selector);
  if (!found) throw new Error(`未找到归档：${selector}（可用 --list 查看）`);
  return found;
}

function renderArchives(out, report) {
  out(`[INFO] 任务：${report.slug}`);
  if (!report.archives.length) {
    out('[INFO] 没有归档记录。');
    return;
  }
  out(`[INFO] 归档 ${report.archives.length} 份（最新在前）：`);
  for (const item of report.archives) {
    if (item.error) {
      out(`  - ${item.name}（不可恢复：${item.error}）`);
      continue;
    }
    const meta = [
      item.from ? `from ${item.from}` : null,
      item.purge ? '含起点' : null,
      item.createdAt || null,
      item.files.length && item.remaining === 0 ? '已恢复' : null,
    ].filter(Boolean).join('，');
    out(`  - ${item.name}${meta ? `（${meta}）` : ''}`);
    out(`    文件：${item.files.length ? item.files.join('、') : '（无）'}`);
  }
}

/**
 * 从归档恢复产物。默认预览；--apply 才移动。
 * 目标已存在时默认整体拒绝，--force 才覆盖，并先把被覆盖的文件备份到归档目录下。
 * 执行时与 change 共用任务锁，避免并发移动同一批产物。
 */
export function runRestore(options = {}) {
  if (!options.apply) return restoreOnce(options);
  const target = resolve(options.root);
  // slug 非法、任务不存在或目录越界时交由 restoreOnce 报错，不能先创建锁文件。
  if (!validSlug(options.slug)) return restoreOnce(options);
  const dir = join(target, 'docs', 'devflow', options.slug);
  if (!existsSync(dir)) return restoreOnce(options);
  if (!isPathInside(target, dir) || !isRealPathInside(target, dir)) return restoreOnce(options);
  return withFileLock(join(dir, '.change'), () => restoreOnce(options), { failClosed: true, timeoutMs: 5000 });
}

function restoreOnce({
  root, slug, archive, apply = false, force = false, ops = defaultOps, out = console.log, now = () => new Date(),
} = {}) {
  const target = resolve(root);
  if (!validSlug(slug)) throw new Error(`非法的 slug：${slug}`);
  const dir = join(target, 'docs', 'devflow', slug);
  if (!existsSync(dir)) throw new Error(`未找到任务：${slug}（查找 docs/devflow/${slug}/）`);
  assertInside(target, dir, '任务目录');
  const base = join(dir, '.archive');
  const listed = listArchives(target, slug);
  const picked = pickArchive(base, archive, listed.archives);
  if (picked.error) throw new Error(`归档 ${picked.name} 不可恢复：${picked.error}`);

  const archiveDir = join(base, picked.name);
  assertInside(base, archiveDir, '归档目录');
  const manifestFile = join(archiveDir, 'manifest.json');
  if (!ops.exists(manifestFile)) {
    throw new Error(`归档 ${picked.name} 缺少 manifest.json，无法确认恢复范围`);
  }
  let manifest;
  try {
    manifest = JSON.parse(ops.readText(manifestFile));
  } catch (err) {
    throw new Error(`无法读取归档 manifest：${err.message}`);
  }
  const files = validManifestFiles(manifest, slug);

  const missing = files.filter((name) => !ops.exists(join(archiveDir, name)));
  const restorable = files.filter((name) => ops.exists(join(archiveDir, name)));
  const conflicts = restorable.filter((name) => ops.exists(join(dir, name)));
  const at = now();
  const report = {
    root: posix(target),
    slug,
    mode: apply ? 'restore' : 'restore-preview',
    archive: picked.name,
    archiveDir: posix(relative(target, archiveDir)),
    from: typeof manifest.from === 'string' ? manifest.from : null,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
    files,
    restorable,
    missing,
    conflicts,
    force: Boolean(force),
    backupDir: null,
    applied: false,
    noop: restorable.length === 0,
    next: `devflow status --slug ${slug}`,
  };

  if (!apply) {
    out('[INFO] devflow change --restore：预览模式（加 --apply 执行）');
    out(`[INFO] 归档：${picked.name}${report.from ? `（from ${report.from}）` : ''}`);
    out(`[INFO] ${restorable.length ? '将恢复' : '没有可恢复的'} ${restorable.length} 项：${restorable.join('、') || '（无）'}`);
    if (missing.length) out(`[WARN] 归档中缺少：${missing.join('、')}`);
    if (conflicts.length) {
      const hint = force
        ? '执行时将先备份当前文件再覆盖'
        : '默认不覆盖，确认覆盖请加 --force';
      out(`[WARN] 目标已存在：${conflicts.join('、')}；${hint}`);
    }
    out(`[INFO] 下一步：${report.next}`);
    return report;
  }

  if (!restorable.length) {
    report.applied = true;
    out('[INFO] 没有可恢复的文件。');
    out(`[INFO] 下一步：${report.next}`);
    return report;
  }
  if (conflicts.length && !force) {
    throw new Error(`目标已存在：${conflicts.join('、')}；确认覆盖请加 --force`);
  }

  const moved = [];
  const backups = [];
  let backupDir = null;
  try {
    if (conflicts.length) {
      const pickedBackup = pickArchiveDir(archiveDir, `replaced-${formatStamp(at)}`, ops, { create: true });
      backupDir = pickedBackup.dir;
      for (const name of conflicts) {
        const from = join(dir, name);
        const to = join(backupDir, name);
        assertInside(dir, from, '覆盖源');
        assertInside(archiveDir, to, '覆盖备份目标');
        ops.rename(from, to);
        backups.push({ from, to });
      }
    }
    for (const name of restorable) {
      const from = join(archiveDir, name);
      const to = join(dir, name);
      assertInside(archiveDir, from, '归档源');
      assertInside(dir, to, '恢复目标');
      ops.rename(from, to);
      moved.push({ from, to });
    }
  } catch (err) {
    const errors = [];
    // 逆序撤销已恢复的文件，再把备份移回原位，避免只恢复一半。
    for (let i = moved.length - 1; i >= 0; i -= 1) {
      try { ops.rename(moved[i].to, moved[i].from); } catch (e) { errors.push(e.message); }
    }
    for (let i = backups.length - 1; i >= 0; i -= 1) {
      try { ops.rename(backups[i].to, backups[i].from); } catch (e) { errors.push(e.message); }
    }
    if (backupDir) {
      try { ops.rmdir(backupDir); } catch (e) { if (e.code !== 'ENOENT') errors.push(e.message); }
    }
    if (errors.length) {
      throw new Error(`${err.message}；回滚未完全成功：${errors.join('；')}；归档保留在 ${posix(archiveDir)}`);
    }
    throw err;
  }

  report.applied = true;
  report.backupDir = backupDir ? posix(relative(target, backupDir)) : null;
  out(`[OK] 已恢复 ${restorable.length} 项到 docs/devflow/${slug}/`);
  if (missing.length) out(`[WARN] 归档中缺少：${missing.join('、')}`);
  if (report.backupDir) out(`[INFO] 被覆盖的文件已备份到 ${report.backupDir}`);
  out(`[INFO] 下一步：${report.next}`);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, [
    '--root', '--slug', '--from', '--purge', '--apply', '--dry-run', '--json',
    '--list', '--restore', '--force',
  ]);
  const json = hasFlag(argv, '--json');
  const apply = hasFlag(argv, '--apply');
  const list = hasFlag(argv, '--list');
  const restoreRequested = hasOption(argv, '--restore');
  const restore = restoreRequested ? argValue(argv, '--restore', null) : null;
  if (apply && hasFlag(argv, '--dry-run')) {
    throw new Error('--apply 与 --dry-run 不能同时使用');
  }
  if (list && restoreRequested) throw new Error('--list 与 --restore 不能同时使用');
  const root = resolve(argValue(argv, '--root', null) || projectRoot());

  if (list || restoreRequested) {
    if (hasOption(argv, '--from')) throw new Error('--list/--restore 不能与 --from 同时使用');
    if (hasOption(argv, '--purge')) throw new Error('--list/--restore 不能与 --purge 同时使用');
    if (list && apply) throw new Error('--list 是只读操作，不能与 --apply 同时使用');

    // 已归档任务可能只剩 .archive，不能用只扫描入口产物的 resolveSlug 推断。
    const slug = argValue(argv, '--slug', null);
    if (!slug) throw new Error('--list/--restore 需要显式指定 --slug');
    if (!validSlug(slug)) throw new Error(`非法的 slug：${slug}`);
    if (!existsSync(join(root, 'docs', 'devflow', slug))) {
      throw new Error(`未找到任务：${slug}（查找 docs/devflow/${slug}/）`);
    }

    const lines = [];
    const out = json ? (line) => lines.push(line) : (line) => console.log(line);
    let report;
    if (list) {
      report = { ...listArchives(root, slug), mode: 'list' };
      renderArchives(out, report);
    } else {
      if (!restore) throw new Error('--restore 需要归档目录名或 latest，例如 --restore latest');
      report = runRestore({
        root,
        slug,
        archive: restore,
        apply,
        force: hasFlag(argv, '--force'),
        out,
      });
    }
    if (json) console.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (hasOption(argv, '--force')) throw new Error('--force 只能与 --restore 一起使用');
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
