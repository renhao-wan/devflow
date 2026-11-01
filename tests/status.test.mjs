import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-status.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { ...r, json: r.status === 0 && r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

function makeTask(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(root, state) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify(state));
}

test('status 在无任务时提示开始需求阶段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-empty-'));
  try {
    const r = run(['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /未发现 docs\/devflow\//);
    assert.match(r.stdout, /\/devflow:req/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 按单个 slug 推断阶段并给出下一步', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-single-'));
  try {
    const dir = makeTask(root, 'add-login');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    writeFileSync(join(dir, 'plan.md'), '# plan\n');
    writeState(root, { testsPending: true });

    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const report = r.json;
    assert.equal(report.activeSlug, 'add-login');
    assert.equal(report.inferred, true);
    assert.equal(report.slugs[0].stage, 'test');
    assert.equal(report.slugs[0].gap, 'test.md');
    assert.match(report.slugs[0].next, /\/devflow:test add-login/);
    assert.ok(report.suggestions.some((s) => s.includes('尚未验证')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在审查产物齐全后标记完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-done-'));
  try {
    const dir = makeTask(root, 'fix-typo');
    for (const name of ['req.md', 'plan.md', 'test.md', 'review.md']) {
      writeFileSync(join(dir, name), '# x\n');
    }
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'done');
    assert.match(r.json.slugs[0].next, /upstream/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在审查后又有未验证改动时回到测试阶段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-retest-'));
  try {
    const dir = makeTask(root, 'post-review-change');
    for (const name of ['req.md', 'plan.md', 'test.md', 'review.md']) {
      writeFileSync(join(dir, name), '# x\n');
    }
    writeState(root, { testsPending: true });
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在多个任务时不擅自选择，也不套用全局测试状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-multi-'));
  try {
    const a = makeTask(root, 'a');
    writeFileSync(join(a, 'req.md'), '# a\n');
    writeFileSync(join(a, 'plan.md'), '# a\n');
    const b = makeTask(root, 'b');
    writeFileSync(join(b, 'req.md'), '# b\n');
    writeState(root, { testsPending: true });

    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.activeSlug, null);
    assert.equal(r.json.slugs.find((s) => s.slug === 'a').stage, 'implement');
    assert.ok(r.json.suggestions.some((s) => s.includes('请显式带上 slug')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 支持 --slug 过滤，未知 slug 报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-filter-'));
  try {
    const dir = makeTask(root, 'only-one');
    writeFileSync(join(dir, 'req.md'), '# req\n');

    const ok = run(['--root', root, '--slug', 'only-one', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json.inferred, false);
    assert.equal(ok.json.slugs.length, 1);

    const bad = run(['--root', root, '--slug', 'missing']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /未找到任务/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
