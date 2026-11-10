import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-status.mjs');

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

const REVIEW = '# 审查记录\n\n## 结论\n\n- [x] 可以交付\n';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-stale-'));
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

function run(root, args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

function json(root, args = []) {
  const result = run(root, ['--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('plan 晚于 test 时提示下游可能过期', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'report', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    touch(join(dir, 'req.md'), 1_000_000);
    touch(join(dir, 'plan.md'), 3_000_000);
    touch(join(dir, 'test.md'), 2_000_000);

    const result = json(root);
    assert.deepEqual(result.slugs[0].staleDownstream.map((item) => [item.upstream, item.downstream]), [
      ['plan.md', 'test.md'],
    ]);
    const text = run(root).stdout;
    assert.match(text, /下游可能过期/);
    assert.match(text, /plan\.md 晚于 test\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('req 晚于 plan 时提示 plan 及下游可能过期', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'report', { 'req.md': REQ, 'plan.md': PLAN });
    touch(join(dir, 'plan.md'), 1_000_000);
    touch(join(dir, 'req.md'), 3_000_000);
    const result = json(root);
    assert.deepEqual(result.slugs[0].staleDownstream.map((item) => item.upstream), ['req.md']);
    assert.match(run(root).stdout, /req\.md 及下游可能需要重跑/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test 晚于 review 时提示 review 可能过期', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'report', {
      'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST, 'review.md': REVIEW,
    });
    touch(join(dir, 'req.md'), 1_000_000);
    touch(join(dir, 'plan.md'), 1_500_000);
    touch(join(dir, 'review.md'), 2_000_000);
    touch(join(dir, 'test.md'), 3_000_000);
    const result = json(root);
    assert.deepEqual(result.slugs[0].staleDownstream.map((item) => item.downstream), ['review.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('正常时间顺序、缺失下游或容差内都不提示', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'report', { 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST });
    touch(join(dir, 'req.md'), 1_000_000);
    touch(join(dir, 'plan.md'), 2_000_000);
    touch(join(dir, 'test.md'), 3_000_000);
    assert.deepEqual(json(root).slugs[0].staleDownstream, []);
    assert.doesNotMatch(run(root).stdout, /下游可能过期/);

    // 容差 1000ms 内的先后顺序不报。
    touch(join(dir, 'test.md'), 2_500_000);
    assert.deepEqual(json(root).slugs[0].staleDownstream, []);

    // 下游缺失时跳过比较，不把缺失当成过期。
    rmSync(join(dir, 'test.md'));
    touch(join(dir, 'plan.md'), 1_500_000);
    assert.deepEqual(json(root).slugs[0].staleDownstream, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量功能 brief 晚于 test 时提示', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'quick', {
      'brief.md': '# 轻量\n\n## 目标\n\n导出按钮可用。\n',
      'test.md': TEST,
    });
    touch(join(dir, 'test.md'), 1_000_000);
    touch(join(dir, 'brief.md'), 3_000_000);
    const result = json(root);
    assert.deepEqual(result.slugs[0].staleDownstream.map((item) => item.upstream), ['brief.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('implement 阶段的下一步同时给出 test 选项', () => {
  const root = makeRoot();
  try {
    writeTask(root, 'report', { 'req.md': REQ, 'plan.md': PLAN });
    const text = run(root).stdout;
    assert.match(text, /阶段：implement/);
    assert.match(text, /\/devflow:implement report/);
    assert.match(text, /\/devflow:test report/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('只有归档目录的任务计入 archived，不出现在 slug 列表', () => {
  const root = makeRoot();
  try {
    const archive = join(root, 'docs', 'devflow', 'old', '.archive', '20260101-000000-000');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ slug: 'old', from: 'req' }));

    const result = json(root);
    assert.deepEqual(result.slugs, []);
    assert.deepEqual(result.archived, ['old']);
    assert.match(run(root).stdout, /已归档任务/);
    assert.match(run(root).stdout, /old/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('按 --slug 查询已归档任务时给出明确提示', () => {
  const root = makeRoot();
  try {
    const archive = join(root, 'docs', 'devflow', 'old', '.archive', '20260101-000000-000');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ slug: 'old', from: 'req' }));
    const result = run(root, ['--slug', 'old']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /任务已归档/);
    assert.match(result.stderr, /\.archive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('正常任务目录里的 .archive 不会被重复计入 archived', () => {
  const root = makeRoot();
  try {
    const dir = writeTask(root, 'report', { 'req.md': REQ });
    mkdirSync(join(dir, '.archive', '20260101-000000-000'), { recursive: true });
    const result = json(root);
    assert.deepEqual(result.archived, []);
    assert.equal(result.slugs.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
