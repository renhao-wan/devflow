import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReviewReport } from '../scripts/lib/review-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'review-triage.mjs');

function makeTask(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function triage(overrides = {}) {
  return {
    trigger: 'auto',
    level: 'high',
    selected: [{ direction: 'security' }, { direction: 'data' }],
    assignments: [{ agent: 'B', directions: ['security'] }],
    deferred: [{ direction: 'data', reason: '超出代理上限 2，主上下文补查' }],
    excluded: [{ direction: 'maintainability', reason: '低风险' }],
    ...overrides,
  };
}

function report(overrides = {}) {
  const {
    trigger = 'auto',
    level = 'high',
    selected = '安全、数据与迁移',
    assigned = 'B:安全',
    deferred = '数据与迁移',
    excluded = '可维护性（低风险）',
    blockingRows = '',
    deliver = true,
    redo = false,
    profile = true,
  } = overrides;
  return [
    '# 审查记录',
    '',
    ...(profile ? [
      '## 审查触发与画像',
      '',
      `- 触发：${trigger}`,
      `- 风险等级：${level}（子代理上限 2）`,
      `- 选中方向（应审全集）：${selected}`,
      `- 实际派单：${assigned}`,
      `- 主上下文补查（deferred）：${deferred}`,
      `- 排除方向与理由：${excluded}`,
      '',
    ] : []),
    '## 验收对照',
    '',
    '| 验收标准 | 实现/测试 | 状态 |',
    '| --- | --- | --- |',
    '| 登录可用 | 测试覆盖 | 已覆盖 |',
    '',
    '## 复用与依赖检查',
    '',
    '不适用',
    '',
    '## 阻断项',
    '',
    '| 文件:行 | 问题 | 触发条件 | 建议 |',
    '| --- | --- | --- | --- |',
    ...(blockingRows ? [blockingRows] : ['|  |  |  |  |']),
    '',
    '## 结论',
    '',
    `- [${deliver ? 'x' : ' '}] 可以交付`,
    `- [${redo ? 'x' : ' '}] 修复阻断项后再审`,
    '',
  ].join('\n');
}

test('完整的审查报告通过门禁', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-ok-'));
  try {
    const dir = makeTask(root, 'ok-task');
    writeFileSync(join(dir, 'review.md'), report());
    const result = checkReviewReport(root, 'ok-task', { triage: triage() });
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模板原样保留时门禁失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-template-'));
  try {
    const dir = makeTask(root, 'template-task');
    writeFileSync(join(dir, 'review.md'), report({
      trigger: 'mandatory / required / auto / user / skipped',
      level: 'low / medium / high / special（子代理上限 0 / 1 / 2 / 4）',
      selected: '',
      assigned: '',
      deferred: '',
      excluded: '',
      deliver: false,
    }));
    const result = checkReviewReport(root, 'template-task', { triage: triage() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('触发')));
    assert.ok(result.errors.some((e) => e.includes('选中方向')));
    assert.ok(result.errors.some((e) => e.includes('尚未勾选')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('有未关闭阻断项时不能标记为可以交付', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-blocking-'));
  try {
    const dir = makeTask(root, 'blocking-task');
    writeFileSync(join(dir, 'review.md'), report({
      blockingRows: '| src/auth.js:10 | 未校验 token | 过期 token | 增加校验 |',
    }));
    const result = checkReviewReport(root, 'blocking-task', { triage: triage() });
    assert.equal(result.ok, false);
    assert.equal(result.checks.blockingRows, 1);
    assert.ok(result.errors.some((e) => e.includes('未关闭')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('结论为修复阻断项后再审时门禁不通过', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-redo-'));
  try {
    const dir = makeTask(root, 'redo-task');
    writeFileSync(join(dir, 'review.md'), report({ deliver: false, redo: true }));
    const result = checkReviewReport(root, 'redo-task', { triage: triage() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('尚未完成')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('画像缺少 deferred 方向时门禁失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-deferred-'));
  try {
    const dir = makeTask(root, 'deferred-task');
    writeFileSync(join(dir, 'review.md'), report({ deferred: '无' }));
    const result = checkReviewReport(root, 'deferred-task', { triage: triage() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('主上下文补查')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('触发结果与 triage 不一致时门禁失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-mismatch-'));
  try {
    const dir = makeTask(root, 'mismatch-task');
    writeFileSync(join(dir, 'review.md'), report({ trigger: 'user' }));
    const result = checkReviewReport(root, 'mismatch-task', { triage: triage() });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('不一致')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skipped 触发必须写明跳过依据与基线结论', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-skipped-'));
  try {
    const dir = makeTask(root, 'skipped-task');
    const body = [
      '## 审查触发与画像',
      '',
      '- 触发：skipped',
      '',
      '## 阻断项',
      '',
      '| 文件:行 | 问题 | 触发条件 | 建议 |',
      '| --- | --- | --- | --- |',
      '|  |  |  |  |',
      '',
      '## 结论',
      '',
      '- [x] 可以交付',
      '- [ ] 修复阻断项后再审',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'review.md'), body);
    const missing = checkReviewReport(root, 'skipped-task', {
      triage: triage({ trigger: 'skipped', selected: [], deferred: [], excluded: [] }),
    });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.includes('跳过依据')));

    const withBaseline = body.replace('- 触发：skipped', '- 触发：skipped\n- 跳过时（trigger=skipped）的基线检查结论与依据：正确性基线检查通过');
    writeFileSync(join(dir, 'review.md'), withBaseline);
    const ok = checkReviewReport(root, 'skipped-task', {
      triage: triage({ trigger: 'skipped', selected: [], deferred: [], excluded: [] }),
    });
    assert.equal(ok.ok, true, ok.errors.join('；'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺少 triage 快照时只提示不阻断', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-no-triage-'));
  try {
    const dir = makeTask(root, 'no-triage');
    writeFileSync(join(dir, 'review.md'), report());
    const result = checkReviewReport(root, 'no-triage', { triage: null });
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('review-triage.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('triage --check 用退出码表示门禁结果', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-cli-'));
  try {
    const dir = makeTask(root, 'cli-task');
    writeFileSync(join(dir, 'review-triage.json'), JSON.stringify(triage()));
    writeFileSync(join(dir, 'review.md'), report({ deliver: false, redo: true }));

    const bad = spawnSync(process.execPath, [SCRIPT, '--root', root, '--slug', 'cli-task', '--check'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /审查门禁/);
    assert.match(bad.stdout, /未完成/);

    writeFileSync(join(dir, 'review.md'), report());
    const good = spawnSync(process.execPath, [SCRIPT, '--root', root, '--slug', 'cli-task', '--check', '--json'], { encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('验收缺口与缺列只给 warning，不阻断门禁', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-trace-'));
  try {
    const dir = makeTask(root, 'trace-task');
    writeFileSync(join(dir, 'req.md'), [
      '# 登录',
      '',
      '## 验收标准',
      '',
      '- [ ] AC-1 登录成功进入首页',
      '- [ ] AC-2 密码错误时提示',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'review.md'), report());
    const result = checkReviewReport(root, 'trace-task', { triage: triage() });
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('未按验收项列表头')));
    assert.ok(result.warnings.some((w) => w.includes('验收跟踪存在 1 项缺口（AC-2）')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('验收对照状态不可识别时提示', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gate-trace-status-'));
  try {
    const dir = makeTask(root, 'trace-status');
    writeFileSync(join(dir, 'req.md'), [
      '# 登录',
      '',
      '## 验收标准',
      '',
      '- [ ] AC-1 登录成功进入首页',
      '- [ ] AC-2 密码错误时提示',
      '',
    ].join('\n'));
    const text = report().replace(
      '| 验收标准 | 实现/测试 | 状态 |\n| --- | --- | --- |\n| 登录可用 | 测试覆盖 | 已覆盖 |',
      '| 验收项 | 验收标准 | 实现/测试 | 状态 |\n| --- | --- | --- | --- |\n| AC-1 | 登录可用 | 测试覆盖 | 待定 |\n| AC-2 | 错误提示 | 测试覆盖 | 已覆盖 |',
    );
    writeFileSync(join(dir, 'review.md'), text);
    const result = checkReviewReport(root, 'trace-status', { triage: triage() });
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('无法识别的验收状态')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
