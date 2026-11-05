import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDebug, checkReq } from '../scripts/lib/stage-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'stage-check.mjs');

const REQ = `# 报表导出

## 目标

让运营能导出月度报表。

## 验收标准

- [ ] 点击导出生成 CSV
- [ ] 空数据时提示

## 本次不做

- 不做定时导出

## 技术约束

| 约束 | 取值/说明 |
| --- | --- |
| 是否允许新增依赖 | 不允许 |

## 影响面

| 子项目 | 模块 | 接口/数据 | 说明 |
| --- | --- | --- | --- |
| web | report | /export | 新增 |
`;

const BRIEF = `# 轻量改动

## 目标

修复导出按钮无响应。

## 验收标准

- [ ] 点击后开始下载
- [ ] 失败时有错误提示

## 本次不做

- 不改导出格式

## 改动范围与测试计划

| 文件/模块 | 改动 | 验证方式 |
| --- | --- | --- |
| src/export.js | 绑定事件 | 单测 |

- 正常路径：点击下载
- 边界：空数据
- 错误路径：网络失败

## 回滚

revert 本次提交。

## 升级判断

- 触发项：无
`;

const DEBUG = `# 排障记录

## 现象

导出按钮无响应。

## 复现步骤

1. 打开报表页，点击导出。

## 根因

事件绑定在错误元素上。

## 回归测试

- 命令：node --test
- 修复前：失败，TypeError: bind is not a function
- 修复后：通过，2 passed

## 结论

- [x] fixed（根因已修复，回归测试通过）

## 升级判断

- 触发项：无
`;

test('验收 ID：重复报错，显式与缺省混用只提示，全无 ID 不提示', () => {
  const duplicate = checkReq(REQ.replace('- [ ] 点击导出生成 CSV\n- [ ] 空数据时提示',
    '- [ ] AC-1 点击导出生成 CSV\n- [ ] AC-1 空数据时提示'));
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.errors.some((e) => e.includes('验收 ID')));

  const mixed = checkReq(REQ.replace('- [ ] 点击导出生成 CSV\n- [ ] 空数据时提示',
    '- [ ] AC-1 点击导出生成 CSV\n- [ ] 空数据时提示'));
  assert.equal(mixed.ok, true, mixed.errors.join('；'));
  assert.ok(mixed.warnings.some((w) => w.includes('AC ID')));

  const legacy = checkReq(REQ);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.warnings.some((w) => w.includes('AC ID')), false);

  const brief = checkReq(BRIEF.replace('- [ ] 点击后开始下载\n- [ ] 失败时有错误提示',
    '- [ ] AC-1 点击后开始下载\n- [ ] AC-2 失败时有错误提示'), { light: true });
  assert.equal(brief.ok, true);
  assert.equal(brief.warnings.some((w) => w.includes('AC ID')), false);
});

test('完整的 req.md 结构通过', () => {
  const result = checkReq(REQ);
  assert.equal(result.ok, true, result.errors.join('；'));
});

test('缺少验收数量或影响面数据行时失败', () => {
  const text = REQ.replace(/- \[ \] 空数据时提示\n/, '')
    .replace('| web | report | /export | 新增 |', '');
  const result = checkReq(text);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('验收标准')));
  assert.ok(result.errors.some((e) => e.includes('影响面')));
});

test('轻量 brief 必须覆盖正常、边界与错误路径', () => {
  assert.equal(checkReq(BRIEF, { light: true }).ok, true);
  const missing = checkReq(BRIEF.replace('- 边界：空数据\n', ''), { light: true });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('边界')));
});

test('debug 结论必须单选，回归证据不能停留在模板占位', () => {
  assert.equal(checkDebug(DEBUG).ok, true, checkDebug(DEBUG).errors.join('；'));

  const none = checkDebug(DEBUG.replace('- [x] fixed（根因已修复，回归测试通过）', '- [ ] fixed'));
  assert.equal(none.ok, false);
  assert.ok(none.errors.some((e) => e.includes('结论')));

  const both = checkDebug(DEBUG.replace('- [x] fixed（根因已修复，回归测试通过）', '- [x] fixed\n- [x] partial'));
  assert.equal(both.ok, false);

  const placeholder = checkDebug(DEBUG
    .replace('失败，TypeError: bind is not a function', '失败（实际输出摘要）')
    .replace('通过，2 passed', '通过（实际输出摘要）'));
  assert.equal(placeholder.ok, false);
  assert.ok(placeholder.errors.some((e) => e.includes('修复前')));
});

test('debug 缺少根因或复现步骤时失败', () => {
  const result = checkDebug(DEBUG.replace('事件绑定在错误元素上。', '').replace('1. 打开报表页，点击导出。', '1. ...'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('根因')));
  assert.ok(result.errors.some((e) => e.includes('复现步骤')));
});

test('debug 升级判断未填写时阻断', () => {
  const result = checkDebug(DEBUG.replace('- 触发项：无', '- 触发项：'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('升级判断')));
});

test('升级判断标题带括号说明时仍能匹配', () => {
  const text = DEBUG.replace('## 升级判断', '## 升级判断（命中硬触发时填写）');
  const result = checkDebug(text);
  assert.equal(result.ok, true, result.errors.join('；'));
});

function makeRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeTask(root, slug, files) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

function run(args, root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { ...r, json };
}

test('CLI 对完整 req 通过、对缺失结构退出 1', () => {
  const root = makeRoot('devflow-check-req-');
  try {
    writeTask(root, 'demo', { 'req.md': REQ });
    const ok = run(['--stage', 'req', '--slug', 'demo'], root);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    writeTask(root, 'bad', { 'req.md': '# 空需求\n' });
    const bad = run(['--stage', 'req', '--slug', 'bad', '--json'], root);
    assert.equal(bad.status, 1);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.stage, 'req');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 按 brief.md 判断轻量流程，debug 校验独立产物', () => {
  const root = makeRoot('devflow-check-light-');
  try {
    writeTask(root, 'brief-task', { 'brief.md': BRIEF });
    assert.equal(run(['--stage', 'req', '--slug', 'brief-task'], root).status, 0);

    writeTask(root, 'bug-task', { 'debug.md': DEBUG });
    assert.equal(run(['--stage', 'debug', '--slug', 'bug-task'], root).status, 0);

    writeTask(root, 'bug-bad', { 'debug.md': DEBUG.replace('- [x] fixed（根因已修复，回归测试通过）', '- [ ] fixed') });
    assert.equal(run(['--stage', 'debug', '--slug', 'bug-bad'], root).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 缺少 --stage 或阶段未知时报错', () => {
  const root = makeRoot('devflow-check-args-');
  try {
    assert.notEqual(spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' }).status, 0);
    const unknown = spawnSync(process.execPath, [SCRIPT, '--root', root, '--stage', 'x'], { encoding: 'utf8' });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /未知阶段/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
