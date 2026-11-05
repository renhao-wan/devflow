import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_MARKER } from '../scripts/lib/common.mjs';
import { BUILD_SIGNATURES } from '../scripts/lib/discover.mjs';
import { STACK_BY_LABEL, detectWorkspaceStacks, stackNameForLabel } from '../scripts/lib/stacks.mjs';
import { planDrafts, renderProjectBasicsDraft, renderStackDraft } from '../scripts/lib/drafts.mjs';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'devflow-drafts-'));
}

function touch(root, rel) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '');
}

test('label → stack 映射覆盖所有构建文件标签', () => {
  for (const { label } of BUILD_SIGNATURES) {
    assert.ok(STACK_BY_LABEL[label], `缺少 ${label} 的栈映射`);
  }
  assert.equal(stackNameForLabel('Python'), 'python');
  assert.equal(stackNameForLabel('Python / pytest'), 'python');
  assert.equal(stackNameForLabel('未知标签'), null);
});

test('Python 与 pytest 归为同一栈，不误判为多栈', () => {
  const root = makeRoot();
  try {
    touch(root, 'pyproject.toml');
    touch(root, 'pytest.ini');
    const detected = detectWorkspaceStacks(root);
    assert.deepEqual(detected.names, ['python']);
    assert.deepEqual(detected.labels, ['Python', 'Python / pytest']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('根与子项目同为 Node.js 时是单一技术栈', () => {
  const root = makeRoot();
  try {
    touch(root, 'package.json');
    touch(root, 'services/api/package.json');
    const detected = detectWorkspaceStacks(root, [{ path: 'services/api' }]);
    assert.deepEqual(detected.names, ['nodejs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Makefile 作为辅助栈，不把 Node.js 项目误判为多栈', () => {
  const root = makeRoot();
  try {
    touch(root, 'package.json');
    touch(root, 'Makefile');
    const detected = detectWorkspaceStacks(root);
    assert.deepEqual(detected.names, ['nodejs']);
    assert.deepEqual(detected.labels, ['Node.js', 'Make']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('只有 Makefile 时仍按 make 栈处理', () => {
  const root = makeRoot();
  try {
    touch(root, 'Makefile');
    assert.deepEqual(detectWorkspaceStacks(root).names, ['make']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不同技术栈的子项目不会被合并成单一栈', () => {
  const root = makeRoot();
  try {
    touch(root, 'package.json');
    touch(root, 'services/api/pom.xml');
    const detected = detectWorkspaceStacks(root, [{ path: 'services/api' }]);
    assert.deepEqual(detected.names, ['nodejs', 'java-maven']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('没有构建文件时不探测出技术栈', () => {
  const root = makeRoot();
  try {
    const detected = detectWorkspaceStacks(root);
    assert.deepEqual(detected, { names: [], labels: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('草稿带标记、TODO 与落位说明', () => {
  const basics = renderProjectBasicsDraft();
  assert.ok(basics.startsWith(DRAFT_MARKER));
  assert.match(basics, /TODO:/);
  assert.match(basics, /devflow-rule-placement/);
  assert.match(basics, /_shared/);

  const stack = renderStackDraft({ label: 'Node.js', name: 'nodejs' });
  assert.ok(stack.startsWith(DRAFT_MARKER));
  assert.match(stack, /Node\.js 通用规范/);
  assert.match(stack, /TODO:/);
  assert.match(stack, /<stage>\.md/);
});

test('单栈时生成通用与栈两个草稿，多栈或未指定时只生成通用草稿', () => {
  const single = planDrafts({
    detected: { names: ['nodejs'], labels: ['Node.js'] },
    stackName: 'nodejs',
  });
  assert.deepEqual(single.map((d) => d.rel), [
    '.claude/hub/_shared/project-basics.md',
    '.claude/hub/stacks/nodejs/_shared.md',
  ]);
  assert.match(single[1].content, /Node\.js 通用规范/);

  const multi = planDrafts({
    detected: { names: ['nodejs', 'java-maven'], labels: ['Node.js', 'Java / Maven'] },
    stackName: null,
  });
  assert.deepEqual(multi.map((d) => d.rel), ['.claude/hub/_shared/project-basics.md']);

  // stackName 不在探测结果里时不生成栈草稿，避免写出未声明的目录。
  const unknown = planDrafts({
    detected: { names: [], labels: [] },
    stackName: 'nodejs',
  });
  assert.deepEqual(unknown.map((d) => d.rel), ['.claude/hub/_shared/project-basics.md']);
});
