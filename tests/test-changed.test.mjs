import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'mark-test.mjs');

function git(root, ...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function initRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function write(root, rel, content = 'x') {
  mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function run(args, root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { ...r, json };
}

test('--changed 把改动的源码映射到已存在的测试文件', () => {
  const root = initRepo('devflow-changed-');
  try {
    write(root, 'src/a.js', 'export const a = 1;\n');
    write(root, 'tests/a.test.js', 'test();\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    write(root, 'src/a.js', 'export const a = 2;\n');

    const r = run(['--changed', '--json'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.tests, ['tests/a.test.js']);
    assert.deepEqual(r.json.unmapped, []);
    assert.equal(r.json.statsAvailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--changed 把同次改动的测试文件也纳入，未映射源码单独列出', () => {
  const root = initRepo('devflow-changed2-');
  try {
    write(root, 'src/keep.js', 'x\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    write(root, 'tests/keep.test.js', 'changed\n');
    write(root, 'src/orphan.js', 'no test\n');

    const { json } = run(['--changed', '--json'], root);
    assert.deepEqual(json.tests, ['tests/keep.test.js']);
    assert.deepEqual(json.unmapped, ['src/orphan.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--changed 与 --gaps 互斥', () => {
  const root = initRepo('devflow-changed3-');
  try {
    const r = run(['--changed', '--gaps'], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不能同时使用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非 git 目录下 --changed 提示不完整但不失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-changed-nogit-'));
  try {
    write(root, 'src/a.js', 'x\n');
    const r = run(['--changed'], root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[WARN\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
