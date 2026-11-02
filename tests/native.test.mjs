import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '../scripts/lib/common.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

test('阶段入口声明原生子代理兼容工具与结构化提问', () => {
  const expected = {
    req: ['AskUserQuestion'],
    plan: ['Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
    implement: ['Agent', 'AskUserQuestion'],
    test: ['Task', 'Agent', 'AskUserQuestion'],
    debug: ['Task', 'Agent', 'AskUserQuestion'],
    review: ['Task', 'Agent', 'AskUserQuestion'],
  };
  for (const [stage, tools] of Object.entries(expected)) {
    const fm = parseFrontmatter(read(`skills/${stage}/SKILL.md`));
    const allowed = fm['allowed-tools'] || '';
    for (const tool of tools) {
      assert.match(allowed, new RegExp(`\\b${tool}\\b`), `${stage} 的 allowed-tools 缺少 ${tool}`);
    }
  }
});

test('子代理引用使用插件命名空间并保留裸名回退说明', () => {
  const refs = {
    'skills/debug/SKILL.md': 'devflow:devflow-debug-investigator',
    'templates/stages/debug/SKILL.md': 'devflow:devflow-debug-investigator',
    'skills/devflow-systematic-debugging/SKILL.md': 'devflow:devflow-debug-investigator',
    'skills/test/SKILL.md': 'devflow:devflow-test-runner',
    'templates/stages/test/SKILL.md': 'devflow:devflow-test-runner',
    'skills/review/SKILL.md': 'devflow:devflow-code-reviewer',
    'templates/stages/review/SKILL.md': 'devflow:devflow-code-reviewer',
    'skills/devflow-code-review/SKILL.md': 'devflow:devflow-code-reviewer',
  };
  for (const [rel, name] of Object.entries(refs)) {
    const body = read(rel);
    assert.match(body, new RegExp(name.replace(/:/g, '\\:')), `${rel} 未使用命名空间代理名`);
    assert.match(body, /\/agents/, `${rel} 未说明以 /agents 列表为准`);
  }
});

test('关键决策点使用 AskUserQuestion 并支持文本降级', () => {
  const cases = [
    ['skills/debug/SKILL.md', /slug 不唯一时先用 `AskUserQuestion`/],
    ['skills/plan/SKILL.md', /多个时用 `AskUserQuestion`/],
    ['skills/implement/SKILL.md', /多个时用 `AskUserQuestion`/],
    ['skills/test/SKILL.md', /多个时用 `AskUserQuestion`/],
    ['skills/review/SKILL.md', /多个时用 `AskUserQuestion`/],
    ['skills/req/SKILL.md', /软提示时，用 `AskUserQuestion`/],
    ['skills/implement/SKILL.md', /80–200 行或 5–10 个文件时先用 `AskUserQuestion`/],
  ];
  for (const [rel, re] of cases) {
    assert.match(read(rel), re, `${rel} 缺少结构化提问或降级说明`);
  }
});

test('原生能力文档记录命名、版本与降级边界', () => {
  const rel = 'docs/native-capabilities.md';
  assert.ok(existsSync(join(ROOT, ...rel.split('/'))), '缺少原生能力文档');
  const doc = read(rel);
  assert.match(doc, /Claude Code 2\.1\.234/);
  assert.match(doc, /devflow:devflow-code-reviewer/);
  assert.match(doc, /devflow:devflow-test-runner/);
  assert.match(doc, /devflow:devflow-debug-investigator/);
  assert.match(doc, /AskUserQuestion/);
  assert.match(doc, /降级/);
  assert.match(doc, /\/agents/);
  assert.match(read('README.md'), /docs\/native-capabilities\.md/);
});
