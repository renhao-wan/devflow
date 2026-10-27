import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOKS = resolve(import.meta.dirname, '..', 'hooks', 'scripts');
const NODE = process.execPath;

function runHook(script, payload, env = {}) {
  return spawnSync(NODE, [join(HOOKS, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-hook-'));
  mkdirSync(join(root, '.claude', 'hub', 'stages', 'req'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'stages:',
    '  - req',
    '  - test',
    'subprojects:',
    '  api:',
    '    path: services/api',
    '    stages: [test]',
    'defaults:',
    '  testCommand: "npm test"',
    '',
  ].join('\n'));
  return root;
}

test('guard 阻止系统级破坏命令', () => {
  const r = runHook('guard-dangerous.mjs', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('guard 阻止强推 main', () => {
  const r = runHook('guard-dangerous.mjs', { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('guard 对 git reset --hard 要求确认', () => {
  const r = runHook('guard-dangerous.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
});

test('guard 放行普通命令与非 Bash 工具', () => {
  assert.equal(runHook('guard-dangerous.mjs', { tool_name: 'Bash', tool_input: { command: 'git status' } }).stdout, '');
  assert.equal(runHook('guard-dangerous.mjs', { tool_name: 'Read', tool_input: { file_path: 'x' } }).stdout, '');
});

test('track-changes 记录改动并标记待测', () => {
  const root = makeRoot();
  try {
    const r = runHook('track-changes.mjs', {
      tool_name: 'Edit',
      tool_input: { file_path: join(root, 'src', 'a.js') },
    }, { CLAUDE_PROJECT_DIR: root });
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(join(root, '.claude', '.devflow-state.json'), 'utf8'));
    assert.deepEqual(state.changedFiles, ['src/a.js']);
    assert.equal(state.testsPending, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('track-changes 忽略生成投影', () => {
  const root = makeRoot();
  try {
    runHook('track-changes.mjs', {
      tool_name: 'Write',
      tool_input: { file_path: join(root, '.claude', 'skills', 'devflow-req', 'SKILL.md') },
    }, { CLAUDE_PROJECT_DIR: root });
    assert.equal(existsSync(join(root, '.claude', '.devflow-state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-tests 在改动未验证时提醒', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify({
      changedFiles: ['src/a.js'],
      lastChangeAt: '2026-01-01T00:00:00.000Z',
      testsPending: true,
    }));
    const r = runHook('check-tests.mjs', {}, { CLAUDE_PROJECT_DIR: root });
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /尚未验证通过/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-tests 在测试晚于改动时静默', () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify({
      changedFiles: ['src/a.js'],
      lastChangeAt: '2026-01-01T00:00:00.000Z',
      lastTestPassedAt: '2026-01-02T00:00:00.000Z',
      testsPending: true,
    }));
    const r = runHook('check-tests.mjs', {}, { CLAUDE_PROJECT_DIR: root });
    assert.equal(r.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('load-hub 注入阶段与子项目摘要', () => {
  const root = makeRoot();
  try {
    const r = runHook('load-hub.mjs', {}, { CLAUDE_PROJECT_DIR: root });
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /阶段：req, test/);
    assert.match(ctx, /子项目：api/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('load-hub 在无 hub 时静默', () => {
  const empty = mkdtempSync(join(tmpdir(), 'devflow-noHub-'));
  try {
    const r = runHook('load-hub.mjs', {}, { CLAUDE_PROJECT_DIR: empty });
    assert.equal(r.stdout, '');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
