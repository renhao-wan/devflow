import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkStage } from '../scripts/lib/stage-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const STATUS = join(ROOT, 'scripts', 'hub-status.mjs');
const STATUSLINE = join(ROOT, 'scripts', 'statusline.mjs');

const REQ = `# 报表导出

## 目标

让运营能导出月度报表。

## 验收标准

- [ ] AC-1 点击导出生成 CSV
- [ ] AC-2 空数据时提示
`;

const PLAN = `# 报表导出 实施方案

## 任务拆分

| # | 任务 | 涉及文件 | 验证方式 | 验收项 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 导出 CSV | \`src/report.js\` | 单测 | AC-1 | 待开始 |
`;

const TEST = `# 测试报告

- 命令：npm test
- 范围：report

## 结果

| 套件/用例 | 结果 | 说明 |
| --- | --- | --- |
| report | 通过 | 3 passed |

## 验收覆盖

| 验收项 | 测试/证据 | 结论 |
| --- | --- | --- |
| AC-1 | report.test.js | 通过 |
| AC-2 | report.test.js | 通过 |
`;

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ack-'));
  mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'version: 1\n');
  return root;
}

function writeTask(root, slug, files) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function touch(file, ms) {
  const time = new Date(ms);
  utimesSync(file, time, time);
}

function run(script, root, args = []) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}

function json(script, root, args = []) {
  const result = run(script, root, ['--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function staleTask(root) {
  const dir = writeTask(root, 'report', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
  touch(join(dir, 'req.md'), 1_000_000);
  touch(join(dir, 'test.md'), 2_000_000);
  touch(join(dir, 'plan.md'), 3_000_000);
  return dir;
}

test('status --ack 记录指纹并抑制 status、statusline 与 check 的过期提示', () => {
  const root = makeRoot();
  try {
    const dir = staleTask(root);
    // 未确认前，review 门禁能看到 plan→test 的过期 warning。
    const before = checkStage(root, 'report', 'review');
    assert.ok(before.warnings.some((warning) => warning.includes('晚于')));

    const ack = json(STATUS, root, ['--slug', 'report', '--ack']);
    assert.equal(ack.acked, true);
    assert.equal(ack.slug, 'report');
    assert.equal(ack.from, 'plan');
    assert.equal(ack.count, 1);

    const state = JSON.parse(readFileSync(join(root, '.claude', '.devflow-state.json'), 'utf8'));
    assert.equal(state.staleAcks.report.from, 'plan');
    assert.match(state.staleAcks.report.key, /plan\.md@3000000>test\.md@2000000/);

    const report = json(STATUS, root, ['--slug', 'report']);
    assert.equal(report.slugs[0].staleDownstream.length, 1);
    assert.equal(report.slugs[0].staleAcked, true);
    assert.equal(report.suggestions.some((line) => line.includes('devflow change')), false);
    const text = run(STATUS, root, ['--slug', 'report', '--ack']).stdout;
    assert.doesNotMatch(text, /下游可能过期/);
    assert.match(text, /已确认 report 的过期提示/);

    const line = json(STATUSLINE, root, []);
    assert.equal(line.stale, false);
    assert.equal(line.staleFrom, null);
    assert.doesNotMatch(run(STATUSLINE, root, []).stdout, /过期/);

    const checked = checkStage(root, 'report', 'test');
    assert.equal(checked.warnings.some((warning) => warning.includes('晚于')), false);

    // 产物再次变化后指纹失效，提示恢复。
    touch(join(dir, 'plan.md'), 4_000_000);
    const after = json(STATUS, root, ['--slug', 'report']);
    assert.equal(after.slugs[0].staleAcked, false);
    assert.ok(after.slugs[0].staleCommand);
    assert.equal(after.suggestions.some((item) => item.includes('devflow change')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有过期关系时 --ack 不写状态文件', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'report', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    touch(join(dir, 'req.md'), 1_000_000);
    touch(join(dir, 'plan.md'), 2_000_000);
    touch(join(dir, 'test.md'), 3_000_000);
    const result = json(STATUS, root, ['--slug', 'report', '--ack']);
    assert.equal(result.acked, false);
    assert.match(result.reason, /没有下游过期提示/);
    assert.equal(existsSync(join(root, '.claude', '.devflow-state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('多任务时 --ack 必须显式指定 slug', () => {
  const root = makeRoot();
  try {
    const first = writeTask(root, 'one', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    const second = writeTask(root, 'two', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    for (const dir of [first, second]) {
      touch(join(dir, 'req.md'), 1_000_000);
      touch(join(dir, 'test.md'), 2_000_000);
      touch(join(dir, 'plan.md'), 3_000_000);
    }
    const result = run(STATUS, root, ['--ack']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /需要显式指定 --slug/);
    assert.equal(existsSync(join(root, '.claude', '.devflow-state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--ack 只影响指定任务，其他任务仍显示过期', () => {
  const root = makeRoot();
  try {
    const first = writeTask(root, 'one', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    const second = writeTask(root, 'two', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    for (const dir of [first, second]) {
      touch(join(dir, 'req.md'), 1_000_000);
      touch(join(dir, 'test.md'), 2_000_000);
      touch(join(dir, 'plan.md'), 3_000_000);
    }
    json(STATUS, root, ['--slug', 'one', '--ack']);
    const line = json(STATUSLINE, root, []);
    assert.equal(line.stale, true);
    assert.match(run(STATUSLINE, root, []).stdout, /2 个任务 · 过期/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
