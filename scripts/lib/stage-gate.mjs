// req / debug 产物的结构门禁：只做确定性的“是否写了、写全了”检查，
// 不判断需求是否合理或根因是否正确。退出码由 CLI 负责。
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './common.mjs';
import {
  bulletValue, checkboxes, meaningful, section, subsection, tableDataRows, tableHeader, tableRows,
} from './markdown.mjs';
import { detectFlow } from './review.mjs';
import { chainOf, staleDownstream } from './artifact-chain.mjs';
import { planDriftFor } from './plan-drift.mjs';
import { checkReviewReport } from './review-gate.mjs';
import { traceFor } from './trace.mjs';

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

const AC_ID = /^\s*AC[-_ ]?(\d+)\b/i;

function checkAcceptanceIds(errors, warnings, acceptance) {
  if (acceptance === null) return;
  const ids = [];
  let missing = 0;
  for (const item of checkboxes(acceptance)) {
    if (!meaningful(item.text)) continue;
    const match = AC_ID.exec(item.text);
    if (match) ids.push(`AC-${Number(match[1])}`);
    else missing += 1;
  }
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) errors.push(`「验收标准」存在重复的验收 ID：${duplicates.join('、')}`);
  if (ids.length && missing) warnings.push('部分验收项缺少 AC ID，建议统一写成 AC-1、AC-2');
}

/**
 * 模板自带的技术约束取值（`允许 / 需审批 / 不允许`、`例如 ...`、`是 / 否，说明`）
 * 是候选项而不是用户做出的选择，未替换时该行视为未填写。
 */
function isConstraintPlaceholder(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (/^(?:例如|如|填写|说明)/.test(v)) return true;
  const parts = v.split(/\s*[\/／]\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const candidates = /^(?:允许|需审批|不允许|是|否|可用|不可用|说明)$/;
  if (!parts.every((part) => candidates.test(part.replace(/[，,].*$/, '')))) return false;
  // 冒号后补充了真实内容，说明用户已经做出选择。
  return !/[：:]\s*\S/.test(v);
}

function checkCommon(errors, warnings, text, { requirements = true } = {}) {
  const goal = requireSection(errors, text, '目标');
  if (goal !== null && !hasContent(goal)) errors.push('「目标」为空');

  const acceptance = requireSection(errors, text, '验收标准');
  if (acceptance !== null && meaningfulCheckboxes(acceptance).length < 2) {
    errors.push('「验收标准」至少需要 2 条可勾选的验收项');
  }
  checkAcceptanceIds(errors, warnings, acceptance);

  const excluded = requireSection(errors, text, '本次不做');
  if (excluded !== null && !hasContent(excluded)) errors.push('「本次不做」为空');

  if (requirements) {
    const constraints = requireSection(errors, text, '技术约束');
    if (constraints !== null) {
      const filled = tableRows(constraints)
        .some((row) => row.slice(1).some((cell) => !isConstraintPlaceholder(cell)));
      const prose = constraints.split(/\r?\n/).filter((line) => !/^\s*\|/.test(line)).join('\n');
      if (!filled && !hasContent(prose)) errors.push('「技术约束」为空（模板默认取值不算已填写）');
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
  checkCommon(errors, warnings, text, { requirements: !light });

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

  // 升级判断是排障流程的分级依据：即使未命中也要显式写“无”，不能靠省略通过。
  checkUpgrade(errors, warnings, text, { required: true });

  return { ok: errors.length === 0, errors, warnings };
}

export const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

const PLAN_SECTIONS = ['现状', '方案', '任务拆分', '测试策略', '回滚', '风险'];

function cellOf(row, index) {
  return index >= 0 ? String(row[index] || '').trim() : '';
}

function columnOf(header, ...patterns) {
  if (!header) return -1;
  return header.findIndex((value) => patterns.some((pattern) => pattern.test(value)));
}

/** 任务表/改动表的行级必填项；验收项只在验收来源使用显式 AC ID 时强制。 */
function checkTaskTable(errors, warnings, body, title, { requireAc = true } = {}) {
  const header = tableHeader(body);
  const rows = tableRows(body);
  if (!header || rows.length === 0) {
    errors.push(`「${title}」表格没有数据行`);
    return;
  }
  const taskColumn = columnOf(header, /任务/, /改动/);
  const verifyColumn = columnOf(header, /验证/);
  const acColumn = columnOf(header, /验收项|验收 ID/);
  const fileColumn = columnOf(header, /涉及文件/, /文件/);
  if (verifyColumn < 0) errors.push(`「${title}」缺少「验证方式」列`);
  if (acColumn < 0 && requireAc) errors.push(`「${title}」缺少「验收项」列`);
  rows.forEach((row, index) => {
    const label = `「${title}」第 ${index + 1} 行`;
    // AC-1 这类纯 ID 会被 meaningful 判为空，验收项列只要求有文本。
    const hasText = (value) => String(value || '').trim().length > 0;
    if (taskColumn >= 0 && !meaningful(cellOf(row, taskColumn))) errors.push(`${label}缺少任务描述`);
    if (verifyColumn >= 0 && !meaningful(cellOf(row, verifyColumn))) errors.push(`${label}缺少验证方式`);
    if (acColumn >= 0 && requireAc && !hasText(cellOf(row, acColumn))) errors.push(`${label}缺少验收项`);
    if (fileColumn >= 0 && !hasText(cellOf(row, fileColumn))) warnings.push(`${label}未写涉及文件`);
  });
}

function acceptanceGaps(trace) {
  return (trace.items || [])
    .filter((item) => !(item.plan || []).length)
    .map((item) => item.id);
}

export function checkPlan(root, slug, { trace = null } = {}) {
  const errors = [];
  const warnings = [];
  const file = join(root, 'docs', 'devflow', slug, 'plan.md');
  if (!existsSync(file)) return { ok: false, errors: ['缺少 plan.md'], warnings };

  const text = readText(file);
  const t = trace || traceFor(root, slug);
  const requireAc = !t.skipped && t.explicitIds === true;

  for (const title of PLAN_SECTIONS) requireSection(errors, text, title);

  const research = section(text, '调研与复用判断');
  if (research === null) {
    errors.push('缺少「## 调研与复用判断」段落');
  } else {
    const log = subsection(research, '检索记录');
    if (log === null) {
      errors.push('缺少「### 检索记录」小节');
    } else {
      const prose = log.split(/\r?\n/).filter((line) => !/^\s*\|/.test(line)).join('\n');
      if (tableDataRows(log) === 0 && !hasContent(prose) && !/未触发/.test(log)) {
        errors.push('「检索记录」为空（未调研请写“未触发（原因）”）');
      }
    }
  }

  const tasks = section(text, '任务拆分');
  if (tasks !== null) checkTaskTable(errors, warnings, tasks, '任务拆分', { requireAc });

  if (!t.skipped) {
    for (const id of t.references?.plan || []) {
      errors.push(`任务表引用了未定义的验收 ID ${id}`);
    }
    const gaps = acceptanceGaps(t);
    if (gaps.length) {
      const message = `任务表未覆盖验收项 ${gaps.join('、')}`;
      if (t.explicitIds) errors.push(message);
      else warnings.push(`${message}（旧产物无显式 AC ID，仅提示）`);
    }
  } else {
    warnings.push(`无法核对验收覆盖：${t.reason || '缺少验收来源'}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 轻量功能的 plan 与 req 合并为 brief.md，只核对「改动范围与测试计划」。 */
function checkBriefPlan(root, slug) {
  const errors = [];
  const warnings = [];
  const file = join(root, 'docs', 'devflow', slug, 'brief.md');
  if (!existsSync(file)) return { ok: false, errors: ['缺少 brief.md'], warnings };

  const text = readText(file);
  const body = requireSection(errors, text, '改动范围与测试计划');
  if (body !== null) {
    const t = traceFor(root, slug);
    const requireAc = !t.skipped && t.explicitIds === true;
    checkTaskTable(errors, warnings, body, '改动范围与测试计划', { requireAc });
    if (!t.skipped) {
      for (const id of t.references?.plan || []) {
        errors.push(`改动范围与测试计划引用了未定义的验收 ID ${id}`);
      }
      const gaps = acceptanceGaps(t);
      if (gaps.length) {
        const message = `改动范围与测试计划未覆盖验收项 ${gaps.join('、')}`;
        if (t.explicitIds) errors.push(message);
        else warnings.push(`${message}（旧产物无显式 AC ID，仅提示）`);
      }
    }
  }
  warnings.push('轻量功能没有独立 plan.md，已按 brief.md 的改动范围与测试计划核对');
  return { ok: errors.length === 0, errors, warnings };
}

export function checkTest(root, slug, { trace = null } = {}) {
  const errors = [];
  const warnings = [];
  const file = join(root, 'docs', 'devflow', slug, 'test.md');
  if (!existsSync(file)) return { ok: false, errors: ['缺少 test.md'], warnings };

  const text = readText(file);
  for (const label of ['命令', '范围']) {
    const item = bulletValue(text, label);
    if (!item.found || !meaningful(item.value)) errors.push(`缺少「${label}」`);
  }
  for (const label of ['环境', '时间']) {
    const item = bulletValue(text, label);
    if (!item.found || !meaningful(item.value)) warnings.push(`缺少「${label}」`);
  }

  const results = requireSection(errors, text, '结果');
  if (results !== null && tableDataRows(results) === 0) errors.push('「结果」表格没有数据行');

  const coverage = section(text, '覆盖');
  if (coverage === null) {
    warnings.push('缺少「## 覆盖」段落');
  } else {
    for (const label of ['正常路径', '边界', '错误路径']) {
      const item = bulletValue(coverage, label);
      if (!item.found || !meaningful(item.value)) warnings.push(`「覆盖」缺少「${label}」`);
    }
  }

  const acceptance = requireSection(errors, text, '验收覆盖');
  if (acceptance !== null) {
    const header = tableHeader(acceptance);
    const rows = tableRows(acceptance);
    if (!header || rows.length === 0) errors.push('「验收覆盖」表格没有数据行');
    else if (columnOf(header, /结论/, /结果/, /状态/) < 0) errors.push('「验收覆盖」缺少「结论」列');
  }

  const t = trace || traceFor(root, slug);
  if (!t.skipped) {
    for (const id of t.references?.test || []) {
      errors.push(`验收覆盖引用了未定义的验收 ID ${id}`);
    }
    const missing = (t.items || []).filter((item) => !item.test).map((item) => item.id);
    if (missing.length) errors.push(`「验收覆盖」缺少 ${missing.join('、')}`);
    for (const warning of t.warnings || []) {
      if (warning.startsWith('无法识别的测试结论')) warnings.push(warning);
    }
  } else {
    warnings.push(`无法核对验收覆盖：${t.reason || '缺少验收来源'}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 实现阶段没有独立产物：核对计划声明文件与实际 diff。
 * 默认只提示，--strict 才把漂移计为错误；无法统计时跳过，避免把“读不到”当成通过或失败。
 */
export function checkImplement(root, slug, { strict = false, drift = null } = {}) {
  const errors = [];
  const warnings = [];
  const result = drift || planDriftFor(root, slug);
  if (result.skipped) {
    warnings.push(`无法核对计划漂移：${result.reason}`);
    return { ok: true, skipped: true, errors, warnings };
  }

  const target = strict ? errors : warnings;
  for (const file of result.unplannedChanged) target.push(`计划外改动：${file}`);
  for (const file of result.plannedButUnchanged) target.push(`计划未改动：${file}`);

  if (detectFlow(root, slug) === 'light-feature') {
    const file = join(root, 'docs', 'devflow', slug, 'brief.md');
    if (existsSync(file)) {
      const body = section(readText(file), '实施记录');
      if (body === null || !hasContent(body)) {
        warnings.push('「实施记录」为空，建议补实际改动与差异');
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function readTriage(root, slug) {
  const file = join(root, 'docs', 'devflow', slug, 'review-triage.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

export function checkReview(root, slug, { trace = null } = {}) {
  return checkReviewReport(root, slug, { triage: readTriage(root, slug), trace });
}

const STALE_LABELS = {
  plan: '方案可能未反映最新上游',
  implement: '实现可能基于过期计划',
  test: '测试可能未覆盖最新上游',
  review: '审查可能未覆盖最新上游或测试',
};

function mtimeOf(file) {
  try { return statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * 过期只作 warning：mtime 是启发式，不进入 ok 判定，也不受 --strict 影响。
 * anchor 是当前阶段依赖的最后一个链上产物，只提示会影响该阶段的过期关系。
 */
function staleWarnings(root, slug, flow, stage, warnings) {
  const label = STALE_LABELS[stage];
  if (!label) return;
  const chain = chainOf(flow);
  const anchorFile = stage === 'implement' ? 'plan.md' : `${stage}.md`;
  let anchor = chain.indexOf(anchorFile);
  // 轻量流程没有 plan：implement 依赖链首的 brief/debug，没有更早的上游。
  if (stage === 'implement' && anchor < 0) anchor = 0;
  if (anchor < 0) return;
  const dir = join(root, 'docs', 'devflow', slug);
  const mtimes = Object.fromEntries(chain.map((file) => [file, mtimeOf(join(dir, file))]));
  const entries = staleDownstream(chain, mtimes)
    .filter((entry) => chain.indexOf(entry.downstream) <= anchor);
  if (!entries.length) return;
  const first = entries[0];
  const more = entries.length > 1 ? `（另有 ${entries.length - 1} 项过期关系）` : '';
  warnings.push(`${first.upstream} 晚于 ${first.downstream}，${label}${more}；预览归档：devflow change --slug ${slug} --from ${first.from}（确认后加 --apply）`);
}

/** 按任务流程选择校验对象：req 看 req/brief，plan 看 plan/brief，其余按阶段产物。 */
export function checkStage(root, slug, stage, options = {}) {
  const dir = join(root, 'docs', 'devflow', slug);
  const flow = detectFlow(root, slug);
  const wrap = (result) => {
    const checked = { stage, slug, flow, ...result };
    staleWarnings(root, slug, flow, stage, checked.warnings);
    return checked;
  };

  if (stage === 'req') {
    if (flow === 'light-feature') {
      const file = join(dir, 'brief.md');
      if (!existsSync(file)) return wrap({ ok: false, errors: ['缺少 brief.md'], warnings: [] });
      return wrap(checkReq(readText(file), { light: true }));
    }
    const file = join(dir, 'req.md');
    if (!existsSync(file)) {
      const hint = flow === 'light-bug'
        ? '轻量修复请使用 --stage debug；升级为完整流程时先补 req.md'
        : '请先创建 req.md';
      return wrap({ ok: false, errors: [`缺少 req.md（${hint}）`], warnings: [] });
    }
    return wrap(checkReq(readText(file), { light: false }));
  }

  if (stage === 'plan') {
    if (flow === 'light-feature') return wrap(checkBriefPlan(root, slug));
    if (flow === 'light-bug') {
      return wrap({ ok: true, errors: [], warnings: ['轻量修复没有 plan 阶段，修复后直接进入 test'] });
    }
    return wrap(checkPlan(root, slug, options));
  }

  if (stage === 'implement') return wrap(checkImplement(root, slug, options));
  if (stage === 'test') return wrap(checkTest(root, slug, options));
  if (stage === 'review') return wrap(checkReview(root, slug, options));

  if (stage === 'debug') {
    const file = join(dir, 'debug.md');
    if (!existsSync(file)) return wrap({ ok: false, errors: ['缺少 debug.md'], warnings: [] });
    return wrap(checkDebug(readText(file)));
  }

  throw new Error(`未知阶段：${stage}；可选 ${STAGES.join('、')}`);
}
