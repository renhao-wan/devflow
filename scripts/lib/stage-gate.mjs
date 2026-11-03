// req / debug 产物的结构门禁：只做确定性的“是否写了、写全了”检查，
// 不判断需求是否合理或根因是否正确。退出码由 CLI 负责。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './common.mjs';
import {
  bulletValue, checkboxes, meaningful, section, tableDataRows,
} from './markdown.mjs';
import { detectFlow } from './review.mjs';

// 模板自带的说明句不算“已填写”。
const TEMPLATE_NOISE = [
  '谁、在什么场景、要达成什么结果。一句话，不含“优化”“完善”这类空词。',
  '谁、在什么场景、要达成什么结果。一句话。',
  '失败时如何回退，一句话即可。',
];

function isNoise(text) {
  const flat = text.replace(/\s+/g, '');
  return TEMPLATE_NOISE.some((line) => line.replace(/\s+/g, '') === flat);
}

function contentLines(body) {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    // 引用块是模板说明，不是填写内容。
    .filter((line) => !/^\s*>/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.、)])\s*/, ''))
    .map((line) => meaningful(line))
    .filter(Boolean);
}

function hasContent(body) {
  return contentLines(body).some((line) => !isNoise(line));
}

function meaningfulCheckboxes(body) {
  return checkboxes(body).filter((item) => meaningful(item.text).length > 0);
}

function requireSection(errors, text, title) {
  const body = section(text, title);
  if (body === null) errors.push(`缺少「## ${title}」段落`);
  return body;
}

function checkUpgrade(errors, warnings, text, { required = true } = {}) {
  const body = section(text, '升级判断');
  if (body === null) {
    (required ? errors : warnings).push('缺少「## 升级判断」段落');
    return;
  }
  const trigger = bulletValue(body, '触发项');
  if (!trigger.found || !meaningful(trigger.value)) {
    const message = '「升级判断」缺少「触发项」（未命中硬触发请写“无”）';
    (required ? errors : warnings).push(message);
  }
}

function checkCommon(errors, text, { requirements = true } = {}) {
  const goal = requireSection(errors, text, '目标');
  if (goal !== null && !hasContent(goal)) errors.push('「目标」为空');

  const acceptance = requireSection(errors, text, '验收标准');
  if (acceptance !== null && meaningfulCheckboxes(acceptance).length < 2) {
    errors.push('「验收标准」至少需要 2 条可勾选的验收项');
  }

  const excluded = requireSection(errors, text, '本次不做');
  if (excluded !== null && !hasContent(excluded)) errors.push('「本次不做」为空');

  if (requirements) {
    const constraints = requireSection(errors, text, '技术约束');
    if (constraints !== null && !hasContent(constraints) && tableDataRows(constraints) === 0) {
      errors.push('「技术约束」为空');
    }
    const impact = requireSection(errors, text, '影响面');
    if (impact !== null && tableDataRows(impact) === 0) {
      errors.push('「影响面」表格没有数据行');
    }
  }
}

export function checkReq(text, { light = false } = {}) {
  const errors = [];
  const warnings = [];
  checkCommon(errors, text, { requirements: !light });

  if (light) {
    const scope = requireSection(errors, text, '改动范围与测试计划');
    if (scope !== null) {
      if (tableDataRows(scope) === 0) errors.push('「改动范围与测试计划」表格没有数据行');
      for (const label of ['正常路径', '边界', '错误路径']) {
        const item = bulletValue(scope, label);
        if (!item.found || !meaningful(item.value)) {
          errors.push(`「改动范围与测试计划」缺少「${label}」`);
        }
      }
    }
    const rollback = requireSection(errors, text, '回滚');
    if (rollback !== null && !hasContent(rollback)) errors.push('「回滚」为空');
    checkUpgrade(errors, warnings, text);
  }

  return { ok: errors.length === 0, errors, warnings };
}

const CONCLUSION_OPTIONS = ['fixed', 'partial', 'unresolved'];

export function checkDebug(text) {
  const errors = [];
  const warnings = [];

  const conclusion = requireSection(errors, text, '结论');
  if (conclusion !== null) {
    const checked = checkboxes(conclusion).filter((item) => item.checked);
    if (checked.length !== 1) {
      errors.push(`「结论」必须且只能勾选一项（fixed / partial / unresolved），当前勾选 ${checked.length} 项`);
    } else if (!CONCLUSION_OPTIONS.some((option) => checked[0].text.toLowerCase().startsWith(option))) {
      errors.push('「结论」勾选项不是 fixed / partial / unresolved');
    }
  }

  const rootCause = requireSection(errors, text, '根因');
  if (rootCause !== null && !hasContent(rootCause)) errors.push('「根因」为空');

  const steps = requireSection(errors, text, '复现步骤');
  if (steps !== null && !hasContent(steps)) {
    errors.push('「复现步骤」为空（无法复现时请写明缺失条件）');
  }

  const regression = requireSection(errors, text, '回归测试');
  if (regression !== null) {
    const before = bulletValue(regression, '修复前');
    const after = bulletValue(regression, '修复后');
    // 模板把“失败（实际输出摘要）”留作占位，必须替换成真实观察。
    if (!before.found || /实际输出摘要/.test(before.value) || !/失败|报错|error/i.test(before.value)) {
      errors.push('「回归测试」缺少修复前失败证据');
    }
    if (!after.found || /实际输出摘要/.test(after.value) || !/通过|pass/i.test(after.value)) {
      errors.push('「回归测试」缺少修复后通过证据');
    }
  }

  // 小 bug 通常不命中升级条件，模板也只要求命中时填写，因此这里只提示不阻断。
  checkUpgrade(errors, warnings, text, { required: false });

  return { ok: errors.length === 0, errors, warnings };
}

/** 按任务流程选择校验对象：轻量功能看 brief.md，其余看 req.md。 */
export function checkStage(root, slug, stage) {
  const dir = join(root, 'docs', 'devflow', slug);
  const flow = detectFlow(root, slug);

  if (stage === 'req') {
    if (flow === 'light-feature') {
      const file = join(dir, 'brief.md');
      if (!existsSync(file)) return { ok: false, stage, slug, flow, errors: ['缺少 brief.md'], warnings: [] };
      return { stage, slug, flow, ...checkReq(readText(file), { light: true }) };
    }
    const file = join(dir, 'req.md');
    if (!existsSync(file)) {
      return {
        ok: false,
        stage,
        slug,
        flow,
        errors: ['缺少 req.md（轻量功能请先创建 brief.md）'],
        warnings: [],
      };
    }
    return { stage, slug, flow, ...checkReq(readText(file), { light: false }) };
  }

  if (stage === 'debug') {
    const file = join(dir, 'debug.md');
    if (!existsSync(file)) return { ok: false, stage, slug, flow, errors: ['缺少 debug.md'], warnings: [] };
    return { stage, slug, flow, ...checkDebug(readText(file)) };
  }

  throw new Error(`未知阶段：${stage}；可选 req、debug`);
}
