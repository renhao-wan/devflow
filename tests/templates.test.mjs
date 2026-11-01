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

test('调研相关技能入口与子代理具备检索工具', () => {
  for (const rel of ['skills/plan/SKILL.md', 'skills/review/SKILL.md', 'skills/debug/SKILL.md']) {
    const body = read(rel);
    assert.match(body, /WebSearch/, `${rel} 缺少 WebSearch`);
    assert.match(body, /WebFetch/, `${rel} 缺少 WebFetch`);
  }
  assert.match(read('skills/plan/SKILL.md'), /Bash\(gh:\*\)/);
  for (const rel of ['agents/devflow-code-reviewer.md', 'agents/devflow-debug-investigator.md']) {
    const front = read(rel).split('---')[1] || '';
    assert.match(front, /WebSearch/, `${rel} 的 tools 缺少 WebSearch`);
    assert.match(front, /WebFetch/, `${rel} 的 tools 缺少 WebFetch`);
  }
});

test('阶段入口技能 allowed-tools 覆盖子代理与技能调用', () => {
  const expected = {
    req: ['Skill'],
    plan: ['Skill'],
    implement: ['Skill'],
    test: ['Task', 'Skill'],
    debug: ['Task', 'Skill'],
    review: ['Task', 'Skill'],
  };
  for (const [stage, tools] of Object.entries(expected)) {
    const front = read(`skills/${stage}/SKILL.md`).split('---')[1] || '';
    for (const tool of tools) {
      assert.match(front, new RegExp(`allowed-tools:[^\\n]*\\b${tool}\\b`), `${stage} 缺少 ${tool}`);
    }
  }
});

test('review 入口与技能引用 superpowers 的实际技能名', () => {
  for (const rel of ['skills/review/SKILL.md', 'skills/devflow-code-review/SKILL.md',
    'skills/devflow-engineering-flow/SKILL.md', 'templates/stages/review/SKILL.md']) {
    const body = read(rel);
    assert.match(body, /requesting-code-review/, `${rel} 缺少 requesting-code-review`);
    assert.match(body, /receiving-code-review/, `${rel} 缺少 receiving-code-review`);
  }
});

test('测试报告模板记录运行环境', () => {
  const tpl = read('templates/stages/test/templates/test-report.template.md');
  assert.match(tpl, /环境/);
  assert.match(tpl, /OS/);
  assert.match(tpl, /Node/);
  assert.match(tpl, /包管理器/);
});

test('流程技能说明与 superpowers 的协作边界', () => {
  const skill = read('skills/devflow-engineering-flow/SKILL.md');
  assert.match(skill, /## 与 superpowers 的协作边界/);
  assert.match(skill, /以 devflow 为准/);
  assert.match(skill, /fallback/);
});

test('阶段入口技能以阶段 SKILL 为准并引用对应技能与子代理', () => {
  const refs = {
    req: [],
    plan: [/brainstorming/, /writing-plans/],
    implement: [/devflow-tdd/],
    test: [/devflow-test-runner/],
    debug: [/devflow-systematic-debugging/, /devflow-debug-investigator/],
    review: [/devflow-code-review/],
  };
  for (const [stage, patterns] of Object.entries(refs)) {
    const body = read(`skills/${stage}/SKILL.md`);
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

test('六个阶段入口都接入工具路由并支持强制 devflow', () => {
  for (const stage of ['req', 'plan', 'implement', 'test', 'review', 'debug']) {
    const body = read(`skills/${stage}/SKILL.md`);
    assert.match(body, /hub-route\.mjs/, `${stage} 缺少路由命令`);
    assert.match(body, new RegExp(`--stage ${stage}`), `${stage} 路由阶段不匹配`);
    assert.match(body, /--force-devflow/, `${stage} 缺少强制开关`);
    assert.match(body, /阶段顺序、门禁与 `docs\/devflow\/<slug>\/` 产物仍由本阶段负责/, `${stage} 未声明边界`);
    const front = body.split('---')[1] || '';
    assert.match(front, /--force-devflow/, `${stage} argument-hint 缺少 --force-devflow`);
  }
});

test('流程技能说明工具路由模式与默认行为', () => {
  const skill = read('skills/devflow-engineering-flow/SKILL.md');
  assert.match(skill, /## 工具路由/);
  assert.match(skill, /routing\.mode: ask/);
  assert.match(skill, /routing\.mode: auto/);
  assert.match(skill, /technique/);
  assert.match(skill, /workflow/);
  assert.match(skill, /\.ecosystem-state\.json/);
});

test('路由模块与 CLI 随插件发布', () => {
  assert.ok(existsSync(join(ROOT, 'scripts', 'lib', 'ecosystem.mjs')));
  assert.ok(existsSync(join(ROOT, 'scripts', 'hub-route.mjs')));
});

test('轻量功能凭 brief 模板记录目标、验收与升级判断', () => {
  const rel = 'templates/stages/req/templates/brief.template.md';
  assert.ok(existsSync(join(ROOT, ...rel.split('/'))), '缺少 brief 模板');
  const tpl = read(rel);
  assert.match(tpl, /mode: light/);
  assert.match(tpl, /## 目标/);
  assert.match(tpl, /## 验收标准/);
  assert.match(tpl, /## 本次不做/);
  assert.match(tpl, /## 改动范围与测试计划/);
  assert.match(tpl, /## 约束与依赖/);
  assert.match(tpl, /已检索现成实现/);
  assert.match(tpl, /## 回滚/);
  assert.match(tpl, /## 升级判断/);
  assert.match(tpl, /## 实施记录/);
});

test('req 阶段说明轻量模式、硬触发升级与路由优先级', () => {
  const skill = read('templates/stages/req/SKILL.md');
  assert.match(skill, /轻量模式/);
  assert.match(skill, /--light/);
  assert.match(skill, /brief\.md/);
  assert.match(skill, /硬触发/);
  assert.match(skill, /200 行/);
  assert.match(skill, /10 个文件/);
  assert.match(skill, /新增依赖/);
  assert.match(skill, /git diff --numstat/);
  assert.match(skill, /已有 `req\.md` 或 `plan\.md`/);
  const entry = read('skills/req/SKILL.md');
  assert.match(entry.split('---')[1] || '', /--light/);
  assert.match(entry, /brief\.md/);
  assert.match(entry, /--force-devflow/);
  assert.match(entry, /不切换工具/);
});

test('debug 阶段支持独立小 bug、风险标记与升级阈值', () => {
  const skill = read('templates/stages/debug/SKILL.md');
  assert.match(skill, /独立小 bug/);
  assert.match(skill, /debug\.md/);
  assert.match(skill, /review: required/);
  assert.match(skill, /硬触发/);
  assert.match(skill, /slug 从问题描述提炼/);
  assert.match(skill, /200 行/);
  assert.match(skill, /10 个文件/);
  assert.match(skill, /git diff --numstat/);
  assert.match(skill, /不触发升级/);
  assert.match(skill, /不切换 workflow 类工具/);
  const tpl = read('templates/stages/debug/templates/debug-report.template.md');
  assert.match(tpl, /## 正确行为依据/);
  assert.match(tpl, /## 改动范围/);
  assert.match(tpl, /## 回归测试/);
  assert.match(tpl, /修复前/);
  assert.match(tpl, /修复后/);
  assert.match(tpl, /## 升级判断/);
  assert.match(tpl, /review: required/);
  assert.match(tpl, /规模阈值/);
});

test('轻量任务能被实现、测试与审查阶段消费', () => {
  const implement = read('templates/stages/implement/SKILL.md');
  assert.match(implement, /brief\.md/);
  assert.match(implement, /实施记录/);
  assert.match(implement, /硬触发/);
  assert.match(implement, /git diff --numstat/);

  const test = read('templates/stages/test/SKILL.md');
  assert.match(test, /debug\.md/);
  assert.match(test, /回归测试/);
  assert.match(test, /修复前失败/);
  assert.match(test, /前 10 行/);
  assert.match(test, /测试通过即完成/);

  const review = read('templates/stages/review/SKILL.md');
  assert.match(review, /brief\.md/);
  assert.match(review, /debug\.md/);
  assert.match(review, /升级判断/);
  assert.match(read('skills/test/SKILL.md'), /review: required/);
  assert.match(read('skills/implement/SKILL.md'), /brief\.md/);
  assert.match(read('skills/plan/SKILL.md'), /brief\.md/);
});

test('入口技能按 slug 去重并给出零候选提示', () => {
  for (const stage of ['implement', 'test', 'review']) {
    assert.match(read(`skills/${stage}/SKILL.md`), /按 slug 去重/, `${stage} 缺少按 slug 去重`);
  }
  assert.match(read('skills/implement/SKILL.md'), /没有候选时提示先运行 `\/devflow:req`/);
  assert.match(read('skills/implement/SKILL.md'), /--light/);
  assert.match(read('skills/test/SKILL.md'), /没有候选时提示/);
  assert.match(read('skills/review/SKILL.md'), /没有候选时提示/);
});

test('工具路由文档说明轻量入口', () => {
  const doc = read('docs/tool-routing.md');
  assert.match(doc, /## 轻量入口（`--light`）/);
  assert.match(doc, /附加 `--force-devflow`/);
  assert.match(doc, /轻量优先/);
  assert.match(doc, /debug\.md` 是唯一产物/);
});

test('review 模板支持轻量验收来源与升级判断核对', () => {
  const tpl = read('templates/stages/review/templates/review.template.md');
  assert.match(tpl, /## 范围与模式/);
  assert.match(tpl, /轻量功能/);
  assert.match(tpl, /轻量修复/);
  assert.match(tpl, /验收来源/);
  assert.match(tpl, /## 升级判断核对/);
  assert.match(tpl, /硬触发/);
});

test('流程技能说明轻量双通道且不跳测试，审查按通道决定', () => {
  const skill = read('skills/devflow-engineering-flow/SKILL.md');
  assert.match(skill, /轻量功能/);
  assert.match(skill, /轻量修复/);
  assert.match(skill, /req --light/);
  assert.match(skill, /不能跳门禁/);
  assert.match(skill, /## 轻量流程的升级条件/);
  assert.match(skill, /review: required/);
  assert.match(skill, /小功能始终 review/);
  assert.match(skill, /测试通过即结束/);
  assert.match(skill, /git diff --numstat/);
  assert.doesNotMatch(skill, /不减测试与审查/);
  assert.match(read('skills/status/SKILL.md'), /轻量功能/);
});

