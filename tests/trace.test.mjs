import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildTrace, summarizeTrace, traceFor,
} from '../scripts/lib/trace.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'trace.mjs');

const REQ = `# 报表导出

## 验收标准

- [ ] AC-1 点击导出生成 CSV
- [ ] AC-2 空数据时提示
`;

const PLAN = `# 方案

## 任务拆分

| # | 任务 | 涉及文件 | 验证方式 | 验收项 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 导出 | src/export.js | 单测 | AC-1 | 完成 |
| 2 | 空态 | src/ui.js | 单测 | AC-2 | 完成 |
`;

const TEST = `# 测试报告

## 验收覆盖

| 验收项 | 测试/证据 | 结论 |
| --- | --- | --- |
| AC-1 | tests/export.test.js | 通过 |
| AC-2 | 无 | 未覆盖（缺少用例） |
`;

const REVIEW = `# 审查记录

## 验收对照

| 验收项 | 验收标准 | 实现/测试 | 状态 |
| --- | --- | --- | --- |
| AC-1 | 点击导出 | tests/export.test.js | 已覆盖 |
| AC-2 | 空数据提示 | 无 | 未覆盖 |
`;

function trace(texts, source = 'req') {
  return buildTrace({ flow: 'full', source, texts });
}

test('显式 AC ID 能对齐 plan、test 与 review', () => {
  const result = trace({ acceptance: REQ, plan: PLAN, test: TEST, review: REVIEW });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.items.map((item) => item.id), ['AC-1', 'AC-2']);
  assert.equal(result.items[0].status, 'covered');
  assert.equal(result.items[0].plan.length, 1);
  assert.equal(result.items[0].test.covered, true);
  assert.equal(result.items[1].status, 'uncovered');
  assert.deepEqual(result.missing, ['AC-2']);
  assert.equal(result.totals.gaps, 1);
});

test('review 显式接受未覆盖项时不计入缺口', () => {
  const accepted = REVIEW.replace('| 未覆盖 |', '| 未覆盖（已接受） |');
  const result = trace({ acceptance: REQ, plan: PLAN, test: TEST, review: accepted });
  assert.equal(result.items[1].status, 'accepted');
  assert.equal(result.totals.gaps, 0);
  assert.equal(result.totals.accepted, 1);
});

test('review 阻断优先于测试通过', () => {
  const blocked = REVIEW.replace('| 已覆盖 |', '| 阻断 |');
  const result = trace({ acceptance: REQ, plan: PLAN, test: TEST, review: blocked });
  assert.equal(result.items[0].status, 'blocked');
  assert.equal(result.totals.blocked, 1);
  assert.ok(result.warnings.some((w) => w.includes('以 review 为准')));
});

test('旧产物无 ID 时按顺序推导，旧表头按行序映射', () => {
  const req = REQ.replace('AC-1 ', '').replace('AC-2 ', '');
  const plan = `# 方案

## 任务拆分

| # | 任务 | 涉及文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 导出 | src/export.js | 单测 | 完成 |
`;
  const review = `## 验收对照

| 验收标准 | 实现/测试 | 状态 |
| --- | --- | --- |
| 点击导出 | tests/export.test.js | 已覆盖 |
| 空数据提示 | 无 | 未覆盖（已接受） |
`;
  const test = `# 测试报告

## 结果

| 套件 | 结果 |
| --- | --- |
| 导出 | 通过 |
`;
  const result = trace({ acceptance: req, plan, test, review });
  assert.deepEqual(result.items.map((item) => item.id), ['AC-1', 'AC-2']);
  assert.equal(result.items[0].status, 'covered');
  assert.equal(result.items[1].status, 'accepted');
  assert.equal(result.totals.gaps, 0);
  assert.ok(result.warnings.some((w) => w.includes('按出现顺序推导')));
  assert.ok(result.warnings.some((w) => w.includes('缺少「验收项」列')));
});

test('重复 ID 被重编号，混合 ID 按顺序补齐', () => {
  const dupResult = trace({ acceptance: `${REQ}- [ ] AC-1 重复项\n` });
  assert.deepEqual(dupResult.items.map((item) => item.id), ['AC-1', 'AC-2', 'AC-3']);
  assert.ok(dupResult.warnings.some((w) => w.includes('重复的验收 ID')));

  const mixedReq = REQ.replace('AC-1 ', 'AC-2 ').replace('AC-2 空数据时提示', '空数据时提示');
  const mixed = trace({ acceptance: mixedReq });
  assert.deepEqual(mixed.items.map((item) => item.id), ['AC-2', 'AC-1']);
  assert.ok(mixed.warnings.some((w) => w.includes('部分验收项缺少 AC ID')));
});

test('plan 只映射不算覆盖，缺少计划列时给出 warning', () => {
  const result = trace({ acceptance: REQ, plan: PLAN, test: '# 测试报告\n', review: '# 审查记录\n' });
  assert.equal(result.items[0].status, 'planned');
  assert.equal(result.totals.planned, 2);
  assert.equal(result.totals.gaps, 2);
  assert.ok(result.warnings.some((w) => w.includes('缺少「## 验收覆盖」')));
  assert.ok(result.warnings.some((w) => w.includes('缺少「## 验收对照」')));
});

test('debug 的「正确行为依据」作为验收来源', () => {
  const debug = `# 排障

## 正确行为依据

- AC-1 点击导出应下载 CSV
- 空数据时应给出提示
`;
  const test = `## 验收覆盖

| 验收项 | 测试/证据 | 结论 |
| --- | --- | --- |
| AC-1 | tests/export.test.js | 通过 |
`;
  const result = buildTrace({ flow: 'light-bug', source: 'debug', texts: { acceptance: debug, plan: null, test, review: '' } });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.items.map((item) => item.id), ['AC-1', 'AC-2']);
  assert.equal(result.totals.gaps, 1);
  assert.deepEqual(result.missing, ['AC-2']);
  assert.ok(result.warnings.some((w) => w.includes('部分验收项缺少 AC ID')));
});

test('brief 的改动范围表作为轻量流程的计划映射', () => {
  const brief = `---
mode: light
---

# 轻量功能

## 验收标准

- [ ] AC-1 点击后开始下载
- [ ] AC-2 失败时有提示

## 改动范围与测试计划

| 文件/模块 | 改动 | 验证方式 | 验收项 |
| --- | --- | --- | --- |
| src/export.js | 绑定事件 | 单测 | AC-1、AC-2 |
`;
  const result = buildTrace({ flow: 'light-feature', source: 'brief', texts: { acceptance: brief, plan: brief, test: '', review: '' } });
  assert.equal(result.items[0].plan.length, 1);
  assert.equal(result.items[0].plan[0].files, 'src/export.js');
  assert.equal(result.items[0].plan[0].task, '绑定事件');
  assert.equal(result.items[1].status, 'planned');
});

test('没有验收来源时返回 skipped', () => {
  const result = trace({ acceptance: '# 空需求\n' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /验收标准/);

  const summary = summarizeTrace(result);
  assert.equal(summary.skipped, true);
  assert.equal(summary.gaps, 0);
});

function makeTask(files) {
  const root = mkdtempSync(join(tmpdir(), 'devflow-trace-'));
  const dir = join(root, 'docs', 'devflow', 'demo');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return root;
}

function run(args, root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { ...r, json };
}

test('CLI 默认只读，--check 在缺口时退出 1', () => {
  const root = makeTask({ 'req.md': REQ, 'plan.md': PLAN, 'test.md': TEST, 'review.md': REVIEW });
  try {
    const readOnly = run(['--slug', 'demo'], root);
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.match(readOnly.stdout, /AC-2/);
    assert.match(readOnly.stdout, /缺口 1/);

    const checked = run(['--slug', 'demo', '--check'], root);
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /\[ERR\]/);

    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'review.md'), REVIEW.replace('| 未覆盖 |', '| 未覆盖（已接受） |'));
    assert.equal(run(['--slug', 'demo', '--check'], root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --json 输出完整模型，skipped 时退出 0', () => {
  const root = makeTask({ 'brief.md': '---\nmode: light\n---\n\n# 轻量\n\n## 验收标准\n\n- [ ] ...\n' });
  try {
    const result = run(['--slug', 'demo', '--check', '--json'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.skipped, true);
    assert.match(result.json.reason, /没有可追踪的验收项/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('traceFor 读取流程产物并标注缺失文件', () => {
  const root = makeTask({ 'req.md': REQ, 'plan.md': PLAN });
  try {
    const result = traceFor(root, 'demo');
    assert.equal(result.flow, 'full');
    assert.equal(result.source, 'req');
    assert.equal(result.sources.test, false);
    assert.ok(result.warnings.some((w) => w.includes('缺少 test.md')));
    assert.ok(result.warnings.some((w) => w.includes('缺少 review.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
