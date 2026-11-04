import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isValidStackName, planStacks } from '../scripts/lib/stacks.mjs';

const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'devflow-stacks-'));
}

function writeStack(root, name, files = {}) {
  const dir = join(root, '.claude', 'hub', 'stacks', name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

test('技术栈名只允许安全的目录名', () => {
  for (const name of ['java-spring', 'vue3', 'a', 'a_b', '0abc']) {
    assert.equal(isValidStackName(name), true, name);
  }
  for (const name of ['', 'Java', '../x', 'a/b', 'a\\b', '-a', '_a', 'a b']) {
    assert.equal(isValidStackName(name), false, name);
  }
});

test('未声明 stack 时不产生映射', () => {
  const root = makeRoot();
  try {
    const plan = planStacks(root, { subprojects: {} }, STAGES);
    assert.deepEqual(plan.rows, []);
    assert.deepEqual(plan.issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('单项目使用顶层 stack，并映射 _shared 与阶段文件', () => {
  const root = makeRoot();
  try {
    writeStack(root, 'java-spring', {
      '_shared.md': '# 通用\n',
      'plan.md': '# 方案\n',
      'references/style.md': '# 风格\n',
    });
    const plan = planStacks(root, { stack: 'java-spring', subprojects: {} }, STAGES);
    assert.equal(plan.rows.length, 1);
    const [row] = plan.rows;
    assert.equal(row.subproject, '（工作区根）');
    assert.equal(row.path, '.');
    assert.equal(row.stack, 'java-spring');
    assert.equal(row.dirExists, true);
    assert.equal(row.sharedFile, '.claude/hub/stacks/java-spring/_shared.md');
    assert.equal(row.stageFile.plan, '.claude/hub/stacks/java-spring/plan.md');
    assert.equal(row.stageFile.req, undefined);
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.stacks[0].stages.plan, '.claude/hub/stacks/java-spring/plan.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('子项目覆盖顶层 stack，未声明时继承', () => {
  const root = makeRoot();
  try {
    writeStack(root, 'java-spring', { '_shared.md': '# java\n' });
    writeStack(root, 'vue3', { 'review.md': '# vue review\n' });
    const config = {
      stack: 'java-spring',
      subprojects: {
        api: { path: 'services/api' },
        web: { path: 'apps/web', stack: 'vue3' },
      },
    };
    const plan = planStacks(root, config, STAGES);
    assert.deepEqual(plan.rows.map((row) => [row.subproject, row.path, row.stack]), [
      ['api', 'services/api', 'java-spring'],
      ['web', 'apps/web', 'vue3'],
    ]);
    assert.equal(plan.rows[0].sharedFile, '.claude/hub/stacks/java-spring/_shared.md');
    assert.equal(plan.rows[1].stageFile.review, '.claude/hub/stacks/vue3/review.md');
    assert.deepEqual(plan.issues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('被引用的技术栈目录缺失是错误', () => {
  const root = makeRoot();
  try {
    const plan = planStacks(root, { stack: 'missing' }, STAGES);
    assert.equal(plan.rows.length, 1);
    assert.equal(plan.rows[0].dirExists, false);
    assert.ok(plan.issues.some((issue) => issue.severity === 'error' && /不存在/.test(issue.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('技术栈目录没有任何 Markdown 时给提醒', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, '.claude', 'hub', 'stacks', 'empty'), { recursive: true });
    const plan = planStacks(root, { stack: 'empty' }, STAGES);
    assert.equal(plan.rows[0].dirExists, true);
    assert.ok(plan.issues.some((issue) => issue.severity === 'warn' && /没有 .md/.test(issue.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非法栈名与非字符串声明是错误，同一栈只报告一次', () => {
  const root = makeRoot();
  try {
    const invalidName = planStacks(root, { stack: 'java/spring' }, STAGES);
    assert.ok(invalidName.issues.some((issue) => /技术栈名非法/.test(issue.message)));
    assert.equal(invalidName.rows[0].invalidName, true);

    const invalidType = planStacks(root, { subprojects: { api: { stack: 3 }, web: { stack: 3 } } }, STAGES);
    const typeIssues = invalidType.issues.filter((issue) => /必须是字符串/.test(issue.message));
    assert.equal(typeIssues.length, 2);

    writeStack(root, 'java-spring', { '_shared.md': '# java\n' });
    const duplicate = planStacks(root, {
      subprojects: {
        api: { stack: 'java-spring' },
        web: { stack: 'java-spring' },
      },
    }, STAGES);
    assert.equal(duplicate.issues.length, 0);
    assert.equal(duplicate.stacks.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('技术栈目录通过 junction 指向项目外时被拒绝', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证 junction');
    return;
  }
  const base = makeRoot();
  const outside = makeRoot();
  let junction = null;
  try {
    writeFileSync(join(outside, '_shared.md'), '# outside\n');
    mkdirSync(join(base, '.claude', 'hub', 'stacks'), { recursive: true });
    junction = join(base, '.claude', 'hub', 'stacks', 'java-spring');
    const link = spawnSync('cmd', ['/c', 'mklink', '/J', junction, outside], { encoding: 'utf8' });
    if (link.status !== 0) {
      t.skip('当前环境无法创建 junction');
      return;
    }
    const plan = planStacks(base, { stack: 'java-spring' }, STAGES);
    assert.ok(plan.issues.some((issue) => /真实路径越出项目/.test(issue.message)));
  } finally {
    if (junction) spawnSync('cmd', ['/c', 'rmdir', junction], { encoding: 'utf8' });
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
