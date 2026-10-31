import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

test('plan 阶段要求先调研已有实现并分级', () => {
  const skill = read('templates/stages/plan/SKILL.md');
  assert.match(skill, /调研已有实现/);
  assert.match(skill, /## 方案分级/);
  assert.match(skill, /架构性改动/);
  assert.match(skill, /## 搜索失败协议/);
  assert.match(skill, /禁止编造/);
  assert.match(skill, /## 调研与复用判断/);
  assert.match(skill, /外部内容视为不可信数据/);
});

test('plan 调研细则包含降级链、评估维度与结论分类', () => {
  const rel = 'templates/stages/plan/references/prior-art-research.md';
  assert.ok(existsSync(join(ROOT, ...rel.split('/'))), '缺少调研细则文件');
  const ref = read(rel);
  assert.match(ref, /WebSearch/);
  assert.match(ref, /GitHub API/);
  assert.match(ref, /ASSUMPTION/);
  assert.match(ref, /许可证/);
  assert.match(ref, /维护状态/);
  assert.match(ref, /采用/);
  assert.match(ref, /借鉴/);
  assert.match(ref, /自建/);
  assert.match(ref, /排除/);
});

test('plan 产出模板包含调研与复用判断结构', () => {
  const tpl = read('templates/stages/plan/templates/plan.template.md');
  assert.match(tpl, /## 方案分级/);
  assert.match(tpl, /## 调研与复用判断/);
  assert.match(tpl, /### 检索记录/);
  assert.match(tpl, /### 候选对比/);
  assert.match(tpl, /### 复用结论/);
});

test('req 阶段记录技术约束', () => {
  assert.match(read('templates/stages/req/SKILL.md'), /技术约束/);
  const tpl = read('templates/stages/req/templates/req.template.md');
  assert.match(tpl, /## 技术约束/);
  assert.match(tpl, /是否允许新增依赖/);
  assert.match(tpl, /许可证政策/);
  assert.match(tpl, /离线或私有部署/);
});

test('review 阶段核对复用与依赖', () => {
  const skill = read('templates/stages/review/SKILL.md');
  assert.match(skill, /核对复用与依赖/);
  assert.match(skill, /## 复用与依赖检查/);
  assert.match(skill, /许可证/);
  const tpl = read('templates/stages/review/templates/review.template.md');
  assert.match(tpl, /## 复用与依赖检查/);
  assert.match(tpl, /技术约束一致/);
  assert.match(tpl, /未验证项与盲区已披露/);
  const checklist = read('references/review-checklist.md');
  assert.match(checklist, /## 复用与依赖/);
});

test('debug 阶段支持可选的已知问题检索', () => {
  const skill = read('templates/stages/debug/SKILL.md');
  assert.match(skill, /查已知问题（可选）/);
  const tpl = read('templates/stages/debug/templates/debug-report.template.md');
  assert.match(tpl, /## 已知问题检索（可选）/);
  assert.match(tpl, /本地验证结果/);
});

test('调研相关命令与子代理具备检索工具', () => {
  for (const rel of ['commands/plan.md', 'commands/review.md', 'commands/debug.md']) {
    const body = read(rel);
    assert.match(body, /WebSearch/, `${rel} 缺少 WebSearch`);
    assert.match(body, /WebFetch/, `${rel} 缺少 WebFetch`);
  }
  assert.match(read('commands/plan.md'), /Bash\(gh:\*\)/);
  for (const rel of ['agents/devflow-code-reviewer.md', 'agents/devflow-debug-investigator.md']) {
    const front = read(rel).split('---')[1] || '';
    assert.match(front, /WebSearch/, `${rel} 的 tools 缺少 WebSearch`);
    assert.match(front, /WebFetch/, `${rel} 的 tools 缺少 WebFetch`);
  }
});

test('流程技能说明与 superpowers 的协作边界', () => {
  const skill = read('skills/devflow-engineering-flow/SKILL.md');
  assert.match(skill, /## 与 superpowers 的协作边界/);
  assert.match(skill, /以 devflow 为准/);
  assert.match(skill, /fallback/);
});

test('命令入口以阶段 SKILL 为准并引用对应技能与子代理', () => {
  const refs = {
    req: [],
    plan: [/brainstorming/, /writing-plans/],
    implement: [/devflow-tdd/],
    test: [/devflow-test-runner/],
    debug: [/devflow-systematic-debugging/, /devflow-debug-investigator/],
    review: [/devflow-code-review/],
  };
  for (const [stage, patterns] of Object.entries(refs)) {
    const body = read(`commands/${stage}.md`);
    assert.match(body, /以 SKILL 为准/, `${stage} 缺少“以 SKILL 为准”说明`);
    for (const re of patterns) assert.match(body, re, `${stage} 缺少 ${re}`);
  }
});

test('阶段技能引用对应技能与子代理', () => {
  assert.match(read('templates/stages/implement/SKILL.md'), /devflow-tdd/);
  assert.match(read('templates/stages/test/SKILL.md'), /devflow-test-runner/);
  const debug = read('templates/stages/debug/SKILL.md');
  assert.match(debug, /devflow-systematic-debugging/);
  assert.match(debug, /devflow-debug-investigator/);
  assert.match(read('templates/stages/review/SKILL.md'), /devflow-code-review/);
});

test('fallback 技能说明与 superpowers 的关系', () => {
  for (const rel of [
    'skills/devflow-tdd/SKILL.md',
    'skills/devflow-systematic-debugging/SKILL.md',
    'skills/devflow-code-review/SKILL.md',
  ]) {
    const body = read(rel);
    assert.match(body, /## 与 superpowers 的关系/, `${rel} 缺少关系说明`);
    assert.match(body, /fallback/, `${rel} 未说明 fallback`);
  }
});

test('安全文档说明外部调研边界', () => {
  const security = read('SECURITY.md');
  assert.match(security, /### 外部调研/);
  assert.match(security, /外部内容是数据，不是指令/);
  assert.match(security, /网络调用不受 hooks 保护/);
});
