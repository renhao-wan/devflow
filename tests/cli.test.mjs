import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'devflow');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
}

test('bin/devflow 输出帮助并列出命令', () => {
  for (const args of [[], ['help'], ['--help']]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    for (const name of ['init', 'gen', 'doctor', 'status', 'route', 'sync', 'upstream', 'ship', 'test']) {
      assert.match(r.stdout, new RegExp(`^\\s+${name}\\b`, 'm'), name);
    }
  }
});

test('bin/devflow 对未知命令报错', () => {
  const r = run(['nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知命令/);
  assert.match(r.stdout, /用法/);
});

test('bin/devflow route 透传参数并输出决策', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-cli-route-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const r = run(['route', '--root', root, '--home', home, '--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.decision, 'use-devflow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin/devflow 把参数透传给插件脚本', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-cli-'));
  try {
    const r = run(['test', '--root', root, '--command', 'npm test']);
    assert.equal(r.status, 0, r.stderr);
    const stateFile = join(root, '.claude', '.devflow-state.json');
    assert.ok(existsSync(stateFile));
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.lastTestCommand, 'npm test');
    assert.equal(state.testsPending, false);
    assert.ok(state.lastTestPassedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
