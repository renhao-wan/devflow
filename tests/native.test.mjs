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

test('实现、测试、排障提供可选 goal 完成条件且不替代门禁', () => {
  const templates = [
    'templates/stages/implement/SKILL.md',
    'templates/stages/test/SKILL.md',
    'templates/stages/debug/SKILL.md',
  ];
  for (const rel of templates) {
    const body = read(rel);
    assert.match(body, /## 可选完成条件（\/goal）/, `${rel} 缺少 goal 小节`);
    assert.match(body, /不替代门禁/, `${rel} 未声明 goal 不替代门禁`);
    assert.match(body, /不要启用 goal/, `${rel} 未说明禁用条件`);
  }
  for (const stage of ['implement', 'test', 'debug']) {
    const body = read(`skills/${stage}/SKILL.md`);
    assert.match(body, /\/goal/, `skills/${stage} 缺少 goal 提示`);
    assert.match(body, /不替代门禁/, `skills/${stage} 未声明 goal 不替代门禁`);
  }
});

test('plan 阶段接入 plan mode 与 Plan/Explore 子代理并保留降级', () => {
  for (const rel of ['skills/plan/SKILL.md', 'templates/stages/plan/SKILL.md']) {
    const body = read(rel);
    assert.match(body, /Explore/, `${rel} 未接入 Explore`);
    assert.match(body, /\bPlan\b/, `${rel} 未接入 Plan 子代理`);
    assert.match(body, /EnterPlanMode/, `${rel} 未接入 EnterPlanMode`);
    assert.match(body, /ExitPlanMode/, `${rel} 未接入 ExitPlanMode`);
    assert.match(body, /不改代码|不写文件/, `${rel} 未限制 plan mode 内的写操作`);
  }
  assert.match(read('templates/stages/plan/SKILL.md'), /这些能力是加速手段，不是门禁/);
  assert.match(read('skills/plan/SKILL.md'), /无法使用或用户拒绝时/);
});

test('debug 与 review 支持并行子代理且要求合并冲突', () => {
  const debug = read('templates/stages/debug/SKILL.md');
  assert.match(debug, /## 并行假设验证（可选）/);
  assert.match(debug, /同一条消息/);
  assert.match(debug, /devflow:devflow-debug-investigator/);
  assert.match(debug, /本地复现裁决/);
  assert.match(read('skills/debug/SKILL.md'), /同一条消息并行启动多个/);

  const review = read('templates/stages/review/SKILL.md');
  assert.match(review, /高风险改动/);
  assert.match(review, /两个子代理/);
  assert.match(review, /正确性与安全/);
  assert.match(review, /验收与回归/);
  assert.match(read('skills/review/SKILL.md'), /两个子代理/);

  const template = read('templates/stages/review/templates/review.template.md');
  assert.match(template, /## 子代理交叉审查（可选）/);
  assert.match(template, /视角 A/);
  assert.match(template, /冲突项与裁决依据/);
});

test('工程流程技能汇总原生协作并保留文本降级', () => {
  const flow = read('skills/devflow-engineering-flow/SKILL.md');
  assert.match(flow, /## 原生能力协作（可选）/);
  assert.match(flow, /不替代门禁/);
  assert.match(flow, /AskUserQuestion.*不可用时文本询问/);
  assert.match(flow, /Explore/);
  assert.match(flow, /并行/);
});

test('子代理按职责设置模型并保留兼容回退', () => {
  const models = {
    'agents/devflow-test-runner.md': 'haiku',
    'agents/devflow-code-reviewer.md': 'inherit',
    'agents/devflow-debug-investigator.md': 'inherit',
  };
  for (const [rel, model] of Object.entries(models)) {
    const fm = parseFrontmatter(read(rel));
    assert.equal(fm.model, model, `${rel} 的 model 应为 ${model}`);
  }
  const doc = read('docs/native-capabilities.md');
  assert.match(doc, /model: haiku/);
  assert.match(doc, /model: inherit/);
  assert.match(doc, /删除 `model` 行/);
});

test('review 阶段与内置审查命令协作且限制外发与修改', () => {
  const docs = [
    'skills/review/SKILL.md',
    'templates/stages/review/SKILL.md',
  ];
  for (const rel of docs) {
    const body = read(rel);
    for (const command of ['/code-review', '/security-review', '/ultrareview', '/simplify']) {
      assert.ok(body.includes(command), `${rel} 缺少 ${command}`);
    }
    assert.match(body, /明确同意|先获用户明确同意/, `${rel} 未要求外发前确认`);
    assert.match(body, /回到 implement/, `${rel} 未要求应用修改后回到实现`);
    assert.match(body, /未使用/, `${rel} 未说明不可用时记录`);
  }
  assert.match(read('templates/stages/review/templates/review.template.md'), /内置审查命令/);
});
