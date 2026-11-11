import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultOps, runChange } from '../scripts/hub-change.mjs';
import { listCandidates } from '../scripts/lib/slug.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-change.mjs');
const NOW = () => new Date(2026, 10, 10, 15, 30, 12, 123);

function makeTask(files = ['req.md', 'plan.md', 'test.md', 'review.md', 'review-triage.json']) {
  const root = mkdtempSync(join(tmpdir(), 'devflow-change-'));
  const dir = join(root, 'docs', 'devflow', 'task');
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), `# ${name}\n`);
  return { root, dir };
}

function quiet() {}

function change(root, options = {}) {
  return runChange({
    root,
    slug: 'task',
    from: 'plan',
    out: quiet,
    now: NOW,
    ...options,
  });
}

function archiveDirs(dir) {
  const base = join(dir, '.archive');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function archivedFiles(dir, name) {
  const base = join(dir, '.archive', name);
  return readdirSync(base).sort();
}

test('默认预览不移动文件，并给出归档清单', () => {
  const { root, dir } = makeTask();
  try {
    const report = change(root, { from: 'plan' });
    assert.equal(report.mode, 'preview');
    assert.equal(report.applied, false);
    assert.deepEqual(report.files, ['test.md', 'review.md', 'review-triage.json']);
    assert.deepEqual(report.keep, ['req.md', 'plan.md']);
    assert.equal(existsSync(join(dir, 'test.md')), true);
    assert.equal(archiveDirs(dir).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from plan 归档下游并保留 req/plan', () => {
  const { root, dir } = makeTask();
  try {
    const report = change(root, { from: 'plan', apply: true });
    assert.equal(report.applied, true);
    assert.equal(existsSync(join(dir, 'req.md')), true);
    assert.equal(existsSync(join(dir, 'plan.md')), true);
    for (const name of ['test.md', 'review.md', 'review-triage.json']) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
    const dirs = archiveDirs(dir);
    assert.equal(dirs.length, 1);
    assert.deepEqual(archivedFiles(dir, dirs[0]), [
      'manifest.json', 'review-triage.json', 'review.md', 'test.md',
    ]);
    const manifest = JSON.parse(readFileSync(join(dir, '.archive', dirs[0], 'manifest.json'), 'utf8'));
    assert.equal(manifest.slug, 'task');
    assert.equal(manifest.from, 'plan');
    assert.equal(manifest.flow, 'full');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from req 归档 plan 及下游，保留 req', () => {
  const { root, dir } = makeTask();
  try {
    change(root, { from: 'req', apply: true });
    assert.equal(existsSync(join(dir, 'req.md')), true);
    for (const name of ['plan.md', 'test.md', 'review.md', 'review-triage.json']) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from test 归档测试记录自身及下游', () => {
  const { root, dir } = makeTask();
  try {
    change(root, { from: 'test', apply: true });
    assert.equal(existsSync(join(dir, 'req.md')), true);
    assert.equal(existsSync(join(dir, 'plan.md')), true);
    for (const name of ['test.md', 'review.md', 'review-triage.json']) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from review 只归档审查记录与 triage', () => {
  const { root, dir } = makeTask();
  try {
    change(root, { from: 'review', apply: true });
    assert.equal(existsSync(join(dir, 'test.md')), true);
    assert.equal(existsSync(join(dir, 'review.md')), false);
    assert.equal(existsSync(join(dir, 'review-triage.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from req --purge 归档起点及下游，任务目录只剩归档', () => {
  const { root, dir } = makeTask();
  try {
    const report = change(root, { from: 'req', purge: true, apply: true });
    for (const name of ['req.md', 'plan.md', 'test.md', 'review.md', 'review-triage.json']) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
    assert.equal(archiveDirs(dir).length, 1);
    assert.deepEqual(listCandidates(root), []);
    // req.md 已归档，不能再提示“修改 req.md”。
    assert.match(report.next, /\/devflow:req task/);
    assert.doesNotMatch(report.next, /修改 req\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from req --purge 连同其他流程残留的入口产物一起归档', () => {
  // 完整任务里追加 debug.md 时，若只归档 full 链，debug.md 会让任务被识别成轻量修复。
  const { root, dir } = makeTask(['req.md', 'plan.md', 'test.md', 'review.md', 'debug.md']);
  try {
    const report = change(root, { from: 'req', purge: true, apply: true });
    assert.equal(existsSync(join(dir, 'debug.md')), false);
    assert.deepEqual(listCandidates(root), []);
    assert.equal(report.unrecognized, true);
    assert.match(report.files.join(','), /debug\.md/);
    assert.equal(report.keep.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const feature = makeTask(['brief.md', 'debug.md', 'test.md']);
  try {
    change(feature.root, { from: 'req', purge: true, apply: true });
    assert.equal(existsSync(join(feature.dir, 'debug.md')), false);
    assert.deepEqual(listCandidates(feature.root), []);
  } finally {
    rmSync(feature.root, { recursive: true, force: true });
  }
});

test('--purge 后下一步指向重新生成被归档的阶段', () => {
  const full = makeTask(['req.md', 'plan.md', 'test.md']);
  try {
    const report = change(full.root, { from: 'plan', purge: true, apply: true });
    assert.match(report.next, /\/devflow:plan task/);
    assert.doesNotMatch(report.next, /修改 plan\.md/);
  } finally {
    rmSync(full.root, { recursive: true, force: true });
  }

  const feature = makeTask(['brief.md', 'test.md']);
  try {
    const report = change(feature.root, { from: 'req', purge: true, apply: true });
    assert.match(report.next, /\/devflow:req --light task/);
    assert.doesNotMatch(report.next, /修改 brief\.md/);
  } finally {
    rmSync(feature.root, { recursive: true, force: true });
  }

  const bug = makeTask(['debug.md', 'test.md']);
  try {
    const report = change(bug.root, { from: 'req', purge: true, apply: true });
    assert.match(report.next, /\/devflow:debug task/);
    assert.doesNotMatch(report.next, /修改 debug\.md/);
  } finally {
    rmSync(bug.root, { recursive: true, force: true });
  }
});

test('轻量功能用 brief 作为起点，--from plan 报错', () => {
  const { root, dir } = makeTask(['brief.md', 'test.md', 'review.md', 'review-triage.json']);
  try {
    change(root, { from: 'req', apply: true });
    assert.equal(existsSync(join(dir, 'brief.md')), true);
    assert.equal(existsSync(join(dir, 'test.md')), false);
    assert.throws(() => change(root, { from: 'plan' }), /没有 plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量修复用 debug 作为起点', () => {
  const { root, dir } = makeTask(['debug.md', 'test.md', 'review.md']);
  try {
    change(root, { from: 'req', apply: true });
    assert.equal(existsSync(join(dir, 'debug.md')), true);
    assert.equal(existsSync(join(dir, 'test.md')), false);
    assert.equal(existsSync(join(dir, 'review.md')), false);
    assert.equal(existsSync(join(dir, 'review-triage.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺少起点产物时拒绝归档，避免任务被意外清空', () => {
  const { root } = makeTask(['plan.md', 'test.md']);
  try {
    assert.throws(() => change(root, { from: 'req' }), /没有可回退的 req\.md/);
    assert.throws(() => change(root, { from: 'review' }), /没有可回退的 review\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--from implement 明确报错而不是静默忽略', () => {
  const { root } = makeTask();
  try {
    assert.throws(() => change(root, { from: 'implement' }), /未知的 --from.*implement/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有可归档文件时输出无需归档并退出 0', () => {
  const { root, dir } = makeTask(['req.md', 'plan.md']);
  try {
    const preview = change(root, { from: 'plan' });
    assert.equal(preview.noop, true);
    assert.equal(preview.applied, false);

    const report = change(root, { from: 'plan', apply: true });
    assert.equal(report.noop, true);
    assert.equal(report.applied, true);
    assert.equal(existsSync(join(dir, '.archive')), false);

    const cli = spawnSync(process.execPath, [SCRIPT, '--root', root, '--slug', 'task', '--from', 'plan', '--apply'], {
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /无需归档/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同一时间戳重复归档时追加序号，不覆盖已有归档', () => {
  const { root, dir } = makeTask(['req.md', 'plan.md', 'test.md', 'review.md']);
  try {
    change(root, { from: 'plan', apply: true });
    writeFileSync(join(dir, 'test.md'), '# test.md\n');
    writeFileSync(join(dir, 'review.md'), '# review.md\n');
    change(root, { from: 'plan', apply: true });
    const dirs = archiveDirs(dir).sort();
    assert.equal(dirs.length, 2);
    assert.equal(dirs[1], `${dirs[0]}-1`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rename 失败时逆序回滚，文件与目录恢复原状', () => {
  const { root, dir } = makeTask(['req.md', 'plan.md', 'test.md', 'review.md']);
  try {
    const ops = {
      ...defaultOps,
      rename(from, to) {
        if (from.endsWith('review.md')) throw new Error('模拟移动失败');
        defaultOps.rename(from, to);
      },
    };
    assert.throws(() => change(root, { from: 'plan', apply: true, ops }), /模拟移动失败/);
    assert.equal(existsSync(join(dir, 'test.md')), true);
    assert.equal(existsSync(join(dir, 'review.md')), true);
    assert.equal(archiveDirs(dir).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--json 只向 stdout 输出 JSON，不移动文件', () => {
  const { root, dir } = makeTask();
  try {
    const cli = spawnSync(process.execPath, [
      SCRIPT, '--root', root, '--slug', 'task', '--from', 'plan', '--json',
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const report = JSON.parse(cli.stdout);
    assert.equal(report.mode, 'preview');
    assert.equal(report.slug, 'task');
    assert.deepEqual(report.files, ['test.md', 'review.md', 'review-triage.json']);
    assert.equal(existsSync(join(dir, 'test.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未传 --root 时从子目录向上查找项目根', () => {
  const { root } = makeTask();
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'version: 1\n');
    const sub = join(root, 'src');
    mkdirSync(sub);
    const result = spawnSync(process.execPath, [
      SCRIPT, '--slug', 'task', '--from', 'plan', '--json',
    ], { cwd: sub, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.slug, 'task');
    assert.equal(report.root, root.split('\\').join('/'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非法 --from 与非法的 --dry-run/--apply 组合返回非 0', () => {
  const { root } = makeTask();
  try {
    const bad = spawnSync(process.execPath, [
      SCRIPT, '--root', root, '--slug', 'task', '--from', 'implement',
    ], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /未知的 --from/);

    const both = spawnSync(process.execPath, [
      SCRIPT, '--root', root, '--slug', 'task', '--from', 'plan', '--dry-run', '--apply',
    ], { encoding: 'utf8' });
    assert.equal(both.status, 1);
    assert.match(both.stderr, /不能同时使用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('归档目标经过 junction 指向项目外时拒绝', { skip: process.platform !== 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-change-junction-'));
  const outside = join(base, 'outside');
  try {
    mkdirSync(outside, { recursive: true });
    const { root, dir } = makeTask();
    symlinkSync(outside, join(dir, '.archive'), 'junction');
    assert.throws(() => change(root, { from: 'review', apply: true }), /越界/);
    assert.deepEqual(readdirSync(outside), []);
    assert.equal(existsSync(join(dir, 'review.md')), true);
    rmSync(root, { recursive: true, force: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('默认回退后任务仍可被识别，--purge 后不再识别', () => {
  const { root } = makeTask();
  try {
    change(root, { from: 'req', apply: true });
    assert.deepEqual(listCandidates(root), ['task']);
    change(root, { from: 'req', purge: true, apply: true });
    assert.deepEqual(listCandidates(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
