import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'mark-test.mjs');

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

function stateOf(root) {
  return JSON.parse(readFileSync(join(root, '.claude', '.devflow-state.json'), 'utf8'));
}

function seedState(root, value) {
  writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify(value));
}

function run(args, root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DEVFLOW_PERSONAL_LIBRARY: join(root, '.personal'), DEVFLOW_TEAM_LIBRARY: join(root, '.team') },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { ...r, json };
}

test('记录通过结果：更新通过时间、清除待测试并写入退出码与耗时', () => {
  const root = makeRoot('devflow-mark-pass-');
  try {
    seedState(root, { testsPending: true });
    const r = run(['--command', 'node --test', '--exit-code', '0', '--duration-ms', '1200', '--json'], root);
    assert.equal(r.status, 0, r.stderr);
    const state = stateOf(root);
    assert.equal(state.lastTestStatus, 'passed');
    assert.equal(state.lastTestExitCode, 0);
    assert.equal(state.lastTestDurationMs, 1200);
    assert.equal(state.lastTestCommand, 'node --test');
    assert.equal(state.testsPending, false);
    assert.ok(state.lastTestPassedAt);
    assert.equal(state.lastTestAt, state.lastTestPassedAt);
    assert.equal(r.json.status, 'passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('记录失败结果：保留待测试、不覆盖上次通过时间', () => {
  const root = makeRoot('devflow-mark-fail-');
  try {
    seedState(root, { testsPending: false, lastTestPassedAt: '2026-01-01T00:00:00.000Z' });
    const r = run(['--command', 'node --test', '--exit-code', '2'], root);
    assert.equal(r.status, 0, r.stderr);
    const state = stateOf(root);
    assert.equal(state.lastTestStatus, 'failed');
    assert.equal(state.lastTestExitCode, 2);
    assert.equal(state.testsPending, true);
    assert.equal(state.lastTestPassedAt, '2026-01-01T00:00:00.000Z');
    assert.match(r.stdout, /\[FAIL\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺省退出码按 0 处理，兼容旧用法', () => {
  const root = makeRoot('devflow-mark-default-');
  try {
    const r = run(['--command', 'npm test'], root);
    assert.equal(r.status, 0, r.stderr);
    const state = stateOf(root);
    assert.equal(state.lastTestStatus, 'passed');
    assert.equal(state.lastTestExitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非法 --exit-code 报错且不写状态', () => {
  const root = makeRoot('devflow-mark-bad-');
  try {
    const r = run(['--exit-code', 'abc'], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--exit-code/);
    assert.equal(existsSync(join(root, '.claude', '.devflow-state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
