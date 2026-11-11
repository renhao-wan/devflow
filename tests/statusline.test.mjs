import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'statusline.mjs');
const BIN = join(ROOT, 'bin', 'devflow');

function makeTask(root, slug, files) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    writeFileSync(join(dir, name), name === 'test.md' ? '# test\n\n已运行 node --test。\n' : '# x\n');
  }
  return dir;
}

function run(args, input = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('statusline 输出单行阶段与待测试状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-'));
  try {
    makeTask(root, 'add-login', ['req.md', 'plan.md']);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify({ testsPending: true }));

    const r = run(['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /add-login/);
    assert.match(r.stdout, /test/);
    assert.match(r.stdout, /待测试/);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 单任务标记下游过期并给出归档起点', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-stale-'));
  try {
    const dir = makeTask(root, 'add-login', ['req.md', 'plan.md', 'test.md']);
    const set = (name, ms) => {
      const time = new Date(ms);
      utimesSync(join(dir, name), time, time);
    };
    set('req.md', 1_000_000);
    set('test.md', 2_000_000);
    set('plan.md', 3_000_000);

    const text = run(['--root', root]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /add-login · review · 过期/);
    assert.ok(text.stdout.trim().length <= 80, text.stdout);

    const json = run(['--root', root, '--json']);
    const report = JSON.parse(json.stdout);
    assert.equal(report.stale, true);
    assert.equal(report.staleFrom, 'plan');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 多任务时只给全局过期标记', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-stale-multi-'));
  try {
    const dir = makeTask(root, 'stale-task', ['req.md', 'plan.md', 'test.md']);
    const time = (ms) => new Date(ms);
    utimesSync(join(dir, 'req.md'), time(1_000_000), time(1_000_000));
    utimesSync(join(dir, 'test.md'), time(2_000_000), time(2_000_000));
    utimesSync(join(dir, 'plan.md'), time(3_000_000), time(3_000_000));
    makeTask(root, 'fresh-task', ['req.md', 'plan.md']);

    const text = run(['--root', root]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /2 个任务 · 过期/);

    const report = JSON.parse(run(['--root', root, '--json']).stdout);
    assert.equal(report.stale, true);
    assert.equal(report.staleFrom, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 从 stdin 工作区推导根且不写状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-stdin-'));
  try {
    makeTask(root, 'fix-login', ['req.md', 'plan.md', 'test.md']);
    const r = run([], { workspace: { current_dir: root } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(run(['--json'], { workspace: { current_dir: root } }).stdout);
    assert.equal(out.slug, 'fix-login');
    assert.equal(out.stage, 'review');
    assert.equal(out.testsPending, false);
    assert.equal(existsSync(join(root, '.claude', '.devflow-state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 无任务或根不存在时安全降级', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-empty-'));
  try {
    const empty = run(['--root', root]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /无进行中任务/);

    const missing = run(['--root', join(root, 'missing')]);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /无进行中任务/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline --json 多任务不擅自选择当前任务', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-multi-'));
  try {
    makeTask(root, 'alpha', ['req.md', 'plan.md']);
    makeTask(root, 'beta', ['debug.md']);

    const out = JSON.parse(run(['--root', root, '--json']).stdout);
    assert.equal(out.activeSlug, null);
    assert.equal(out.slug, null);
    assert.equal(out.stage, null);
    assert.equal(out.count, 2);
    assert.deepEqual(out.slugs.map((row) => row.slug).sort(), ['alpha', 'beta']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 多任务显示全局待测试与投影标记', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-flags-'));
  try {
    makeTask(root, 'alpha', ['req.md', 'plan.md']);
    makeTask(root, 'beta', ['debug.md']);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify({
      testsPending: true,
      hubPending: true,
    }));

    const r = run(['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 个任务/);
    assert.match(r.stdout, /待测试/);
    assert.match(r.stdout, /投影待生成/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 从子目录向上查找 hub 根', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-subdir-'));
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'version: 1\nstages:\n  - req\n');
    makeTask(root, 'sub-task', ['req.md', 'plan.md']);
    const sub = join(root, 'services', 'api');
    mkdirSync(sub, { recursive: true });

    const r = run([], { workspace: { current_dir: sub } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sub-task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline 长 slug 截断时保留阶段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-long-'));
  try {
    makeTask(root, 'a'.repeat(120), ['req.md', 'plan.md']);

    const r = run(['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /implement/);
    assert.ok(r.stdout.trim().length <= 80, r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('devflow statusline 通过统一 CLI 分发', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-cli-'));
  try {
    makeTask(root, 'cli-task', ['req.md', 'plan.md']);

    const r = spawnSync(process.execPath, [BIN, 'statusline', '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cli-task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('statusline --root 支持子目录并向上查找项目根', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-statusline-sub-'));
  try {
    makeTask(root, 'sub-task', ['req.md', 'plan.md']);
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'version: 1\n');
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });

    const r = run(['--root', sub, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).slug, 'sub-task');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
