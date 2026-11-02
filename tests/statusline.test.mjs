import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'statusline.mjs');

function makeTask(root, slug, files) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), '# x\n');
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
