import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planDriftFor } from '../scripts/lib/plan-drift.mjs';
import { buildStatus } from '../scripts/hub-status.mjs';

function makeRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'docs', 'devflow', 'demo'), { recursive: true });
  return root;
}

function changes(paths) {
  return {
    files: paths.map((path) => ({ path, additions: 1, deletions: 0 })),
    diffText: '',
    warnings: [],
    statsAvailable: true,
  };
}

const PLAN = `# 计划

## 任务拆分

| # | 任务 | 涉及文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 实现 | src/a.js | 单测 | 待办 |
`;

test('计划外改动与计划未改动分别列出', () => {
  const root = makeRoot('devflow-drift-');
  try {
    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'plan.md'), PLAN);
    const drift = planDriftFor(root, 'demo', { changes: changes(['src/a.js', 'src/b.js']) });
    assert.equal(drift.skipped, false);
    assert.deepEqual(drift.unplannedChanged, ['src/b.js']);
    assert.deepEqual(drift.plannedButUnchanged, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('计划中的文件未改动也会提示', () => {
  const root = makeRoot('devflow-drift2-');
  try {
    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'plan.md'), PLAN);
    const drift = planDriftFor(root, 'demo', { changes: changes([]) });
    assert.deepEqual(drift.plannedButUnchanged, ['src/a.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录声明按前缀匹配，测试与文档改动被忽略', () => {
  const root = makeRoot('devflow-drift3-');
  try {
    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'plan.md'), `# 计划

## 任务拆分

| # | 任务 | 涉及文件 | 验证方式 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 实现 | \`src/auth/\` | 单测 | 待办 |
`);
    const drift = planDriftFor(root, 'demo', {
      changes: changes(['src/auth/session.js', 'tests/auth.test.js', 'docs/guide.md', 'docs/devflow/demo/plan.md']),
    });
    assert.deepEqual(drift.unplannedChanged, []);
    assert.deepEqual(drift.plannedButUnchanged, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量功能读取 brief.md 的改动范围表', () => {
  const root = makeRoot('devflow-drift4-');
  try {
    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'brief.md'), `# 轻量

## 改动范围与测试计划

| 文件/模块 | 改动 | 验证方式 |
| --- | --- | --- |
| src/a.js | 调整 | 单测 |

- 正常路径：通过
- 边界：无
- 错误路径：无
`);
    const drift = planDriftFor(root, 'demo', { changes: changes(['src/other.js']) });
    assert.deepEqual(drift.plannedButUnchanged, ['src/a.js']);
    assert.deepEqual(drift.unplannedChanged, ['src/other.js']);
    assert.equal(drift.source, 'brief.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有计划表或无法统计 git 时跳过，不误报漂移', () => {
  const root = makeRoot('devflow-drift5-');
  try {
    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'req.md'), '# 需求\n');
    assert.equal(planDriftFor(root, 'demo', { changes: changes(['src/a.js']) }).skipped, true);

    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'plan.md'), PLAN);
    const unavailable = { files: [], diffText: '', warnings: ['x'], statsAvailable: false };
    const drift = planDriftFor(root, 'demo', { changes: unavailable });
    assert.equal(drift.skipped, true);
    assert.match(drift.reason, /无法统计/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildStatus 在真实 git 仓库中提示计划外改动，statusline 模式可跳过', () => {
  const root = makeRoot('devflow-drift-git-');
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'docs', 'devflow', 'demo', 'plan.md'), PLAN);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.js'), 'a\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(join(root, 'src', 'a.js'), 'a2\n');
    writeFileSync(join(root, 'src', 'extra.js'), 'b\n');

    const { report } = buildStatus(root, { wanted: 'demo' });
    const row = report.slugs[0];
    assert.equal(row.planDrift.skipped, false);
    assert.deepEqual(row.planDrift.unplannedChanged, ['src/extra.js']);

    const compact = buildStatus(root, { wanted: 'demo', drift: false });
    assert.equal(compact.report.slugs[0].planDrift, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
