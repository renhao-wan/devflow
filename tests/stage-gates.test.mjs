import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkStage } from '../scripts/lib/stage-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'stage-check.mjs');

function makeTask(slug = 'task') {
  const root = mkdtempSync(join(tmpdir(), 'devflow-stage-gates-'));
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  return { root, dir, slug };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

const REQ = `# 报表导出

## 目标

让运营能导出月度报表。

## 验收标准

- [ ] AC-1 点击导出生成 CSV
- [ ] AC-2 空数据时提示

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

const PLAN = `# 报表导出 实施方案

## 现状

\`src/report.js\` 已有导出入口。

## 方案分级

- 级别：有界改动
- 判断理由：只改一个入口

## 调研与复用判断

### 检索记录

| 时间 | 工具 | 查询词/来源 | 结果 |
| --- | --- | --- | --- |
| 2026-11-10 | 本地 | 现有导出实现 | 复用 |

### 复用结论

- 结论：复用
- 理由：已有入口

## 方案

### 推荐方案

复用现有入口。

## 任务拆分

| # | 任务 | 涉及文件 | 验证方式 | 验收项 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 导出 CSV | \`src/report.js\` | 单测 | AC-1 | 待开始 |
| 2 | 空数据提示 | \`src/report.js\` | 单测 | AC-2 | 待开始 |

## 测试策略

- 正常路径：导出
- 边界：空数据
- 错误路径：写盘失败

## 回滚

删除新增入口。

## 风险

| 风险 | 验证动作 |
| --- | --- |
| 写盘权限 | 单测覆盖 |
`;

const TEST_REPORT = `# 测试报告

- 命令：npm test
- 范围：report
- 环境：Node 20 / Windows
- 时间：2026-11-10

## 结果

| 套件/用例 | 结果 | 说明 |
| --- | --- | --- |
| report | 通过 | 3 passed |

## 覆盖

- 正常路径：导出
- 边界：空数据
- 错误路径：写盘失败

## 验收覆盖

| 验收项 | 测试/证据 | 结论 |
| --- | --- | --- |
| AC-1 | report.test.js | 通过 |
| AC-2 | report.test.js | 通过 |

## 未覆盖与原因

无
`;

const REVIEW = `# 审查记录

## 审查触发与画像

- 触发：auto
- 风险等级：low
- 选中方向（应审全集）：无
- 实际派单：无
- 主上下文补查：无
- 排除方向与理由：无

## 验收对照

| 验收项 | 验收标准 | 实现/测试 | 状态 |
| --- | --- | --- | --- |
| AC-1 | 导出 CSV | report.test.js | 已覆盖 |
| AC-2 | 空数据提示 | report.test.js | 已覆盖 |

## 复用与依赖检查

不适用

## 阻断项

| 文件:行 | 问题 | 触发条件 | 建议 |
| --- | --- | --- | --- |
|  |  |  |  |

## 结论

- [x] 可以交付
- [ ] 修复阻断项后再审
`;

function writeFull(root, dir, { plan = PLAN, test = TEST_REPORT, review = REVIEW } = {}) {
  writeFileSync(join(dir, 'req.md'), REQ);
  writeFileSync(join(dir, 'plan.md'), plan);
  writeFileSync(join(dir, 'test.md'), test);
  writeFileSync(join(dir, 'review.md'), review);
  writeFileSync(join(dir, 'review-triage.json'), JSON.stringify({
    trigger: 'auto', level: 'low', selected: [], assignments: [], deferred: [], excluded: [],
  }));
}

test('完整 plan 通过结构门禁', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ);
    writeFileSync(join(dir, 'plan.md'), PLAN);
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, true, result.errors.join('；'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan 任务缺少验证方式时失败', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ);
    writeFileSync(join(dir, 'plan.md'), PLAN.replace('| 单测 | AC-2 |', '|  | AC-2 |'));
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('验证方式')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan 引用未定义验收 ID 时失败', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ);
    writeFileSync(join(dir, 'plan.md'), PLAN.replace('| 单测 | AC-2 |', '| 单测 | AC-9 |'));
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('AC-9')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan 未覆盖上游验收项时失败', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ);
    writeFileSync(join(dir, 'plan.md'), PLAN.replace('| 2 | 空数据提示 | `src/report.js` | 单测 | AC-2 | 待开始 |', ''));
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('AC-2')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('旧产物没有 AC ID 时覆盖缺口只提示', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ.replace(/AC-\d /g, ''));
    writeFileSync(join(dir, 'plan.md'), PLAN.replace(/AC-\d/g, ''));
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('验收')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan 检索记录为空时失败，写“未触发”可通过', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ);
    const emptyTable = PLAN.replace(
      '| 2026-11-10 | 本地 | 现有导出实现 | 复用 |',
      '|  |  |  |  |',
    );
    writeFileSync(join(dir, 'plan.md'), emptyTable);
    const failed = checkStage(root, slug, 'plan');
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((e) => e.includes('检索记录')));

    writeFileSync(join(dir, 'plan.md'), PLAN.replace(
      '### 检索记录\n\n| 时间 | 工具 | 查询词/来源 | 结果 |\n| --- | --- | --- | --- |\n| 2026-11-10 | 本地 | 现有导出实现 | 复用 |',
      '### 检索记录\n\n未触发（小改动，已有现成实现）',
    ));
    const passed = checkStage(root, slug, 'plan');
    assert.equal(passed.ok, true, passed.errors.join('；'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('完整 test 通过结构门禁', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    const result = checkStage(root, slug, 'test');
    assert.equal(result.ok, true, result.errors.join('；'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test 缺少验收覆盖时失败', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir, { test: TEST_REPORT.replace('| AC-2 | report.test.js | 通过 |', '') });
    const result = checkStage(root, slug, 'test');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('AC-2')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test 没有验收项列时按行序回退', () => {
  const { root, dir, slug } = makeTask();
  try {
    const noIdColumn = TEST_REPORT.replace(
      '| 验收项 | 测试/证据 | 结论 |\n| --- | --- | --- |\n| AC-1 | report.test.js | 通过 |\n| AC-2 | report.test.js | 通过 |',
      '| 测试/证据 | 结论 |\n| --- | --- |\n| report.test.js | 通过 |\n| report.test.js | 通过 |',
    );
    writeFull(root, dir, { test: noIdColumn });
    const result = checkStage(root, slug, 'test');
    assert.equal(result.ok, true, result.errors.join('；'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test 结论无法识别时只提示', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir, { test: TEST_REPORT.replace('| report.test.js | 通过 |\n\n## 未覆盖', '| report.test.js | 待补 |\n\n## 未覆盖') });
    const result = checkStage(root, slug, 'test');
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('待补')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test 缺少测试命令时失败', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir, { test: TEST_REPORT.replace('- 命令：npm test', '- 命令：') });
    const result = checkStage(root, slug, 'test');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('命令')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review 阶段复用审查门禁', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    const ok = checkStage(root, slug, 'review');
    assert.equal(ok.ok, true, ok.errors.join('；'));
    writeFileSync(join(dir, 'review.md'), REVIEW.replace('- [x] 可以交付', '- [ ] 可以交付'));
    const failed = checkStage(root, slug, 'review');
    assert.equal(failed.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function makeGitTask({ plan = PLAN, actual = 'src/other.js' } = {}) {
  const { root, dir, slug } = makeTask();
  writeFileSync(join(dir, 'req.md'), REQ);
  writeFileSync(join(dir, 'plan.md'), plan);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'report.js'), 'export {}\n');
  git(root, ['init']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'init']);
  writeFileSync(join(root, ...actual.split('/')), 'export const x = 1;\n');
  return { root, dir, slug };
}

test('implement 默认把计划漂移作为提示', (t) => {
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('git 不可用');
    return;
  }
  const { root, slug } = makeGitTask();
  try {
    const result = checkStage(root, slug, 'implement');
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('计划外')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('implement --strict 把计划漂移升级为错误', (t) => {
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('git 不可用');
    return;
  }
  const { root, slug } = makeGitTask();
  try {
    const result = checkStage(root, slug, 'implement', { strict: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('计划外')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非 git 仓库的 implement 检查跳过而不失败', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'req.md'), REQ);
    writeFileSync(join(dir, 'plan.md'), PLAN);
    const result = checkStage(root, slug, 'implement');
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.skipped === true || result.warnings.some((w) => w.includes('git')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量功能用 brief 检查 plan 表', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'brief.md'), `# 轻量

## 目标

导出按钮可用。

## 验收标准

- [ ] AC-1 点击后下载
- [ ] AC-2 失败有提示

## 本次不做

- 不改格式

## 改动范围与测试计划

| 文件/模块 | 改动 | 验证方式 | 验收项 |
| --- | --- | --- | --- |
| src/export.js | 修复 | 单测 | AC-1 |
| src/export.js | 提示 | 单测 | AC-2 |

## 约束与依赖

- 已检索现成实现：否（未检索）
- 新增依赖：无

## 回滚

还原改动。

## 升级判断

- 触发项：无
`);
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.ok(result.warnings.some((w) => w.includes('brief')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量修复没有 plan 阶段', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFileSync(join(dir, 'debug.md'), '# 排障\n\n## 正确行为依据\n\n- AC-1 现有测试\n');
    const result = checkStage(root, slug, 'plan');
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes('轻量修复')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 支持六个阶段并返回正确退出码', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    for (const stage of ['req', 'plan', 'test', 'review']) {
      const result = runCli(root, ['--slug', slug, '--stage', stage]);
      assert.equal(result.status, 0, `${stage}: ${result.stderr}${result.stdout}`);
    }
    const unknown = runCli(root, ['--slug', slug, '--stage', 'nope']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /req.*plan.*implement.*test.*review.*debug/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function setTimes(dir, times) {
  for (const [name, ms] of Object.entries(times)) {
    const time = new Date(ms);
    utimesSync(join(dir, name), time, time);
  }
}

test('check --stage test 对上游过期给出不阻断的归档建议', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    setTimes(dir, {
      'req.md': 1_000_000, 'plan.md': 3_000_000, 'test.md': 2_000_000, 'review.md': 4_000_000,
    });
    const result = checkStage(root, slug, 'test');
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes('plan.md 晚于 test.md')));
    assert.ok(result.warnings.some((w) => w.includes('devflow change --slug task --from plan')));
    assert.equal(result.errors.length, 0);

    const cli = runCli(root, ['--slug', slug, '--stage', 'test']);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /\[WARN\].*--from plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check --stage review 只归档 review，不把刚更新的 test 算进去', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    setTimes(dir, {
      'req.md': 1_000_000, 'plan.md': 1_500_000, 'review.md': 2_000_000, 'test.md': 3_000_000,
    });
    const result = checkStage(root, slug, 'review');
    assert.equal(result.ok, true);
    const warning = result.warnings.find((w) => w.includes('晚于'));
    assert.ok(warning);
    assert.ok(warning.includes('--from review'));
    assert.ok(!warning.includes('--from test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check --stage plan 与 implement 也能发现上游过期', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    setTimes(dir, {
      'req.md': 3_000_000, 'plan.md': 2_000_000, 'test.md': 1_000_000, 'review.md': 4_000_000,
    });
    const plan = checkStage(root, slug, 'plan');
    assert.equal(plan.ok, true);
    assert.ok(plan.warnings.some((w) => w.includes('req.md 晚于 plan.md') && w.includes('--from req')));

    const implement = checkStage(root, slug, 'implement');
    assert.ok(implement.warnings.some((w) => w.includes('req.md 晚于 plan.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('时间顺序正常时 check 不提示过期', () => {
  const { root, dir, slug } = makeTask();
  try {
    writeFull(root, dir);
    setTimes(dir, {
      'req.md': 1_000_000, 'plan.md': 1_100_000, 'test.md': 1_200_000, 'review.md': 1_300_000,
    });
    for (const stage of ['plan', 'implement', 'test', 'review']) {
      const result = checkStage(root, slug, stage);
      assert.equal(result.warnings.some((w) => w.includes('晚于')), false, stage);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
