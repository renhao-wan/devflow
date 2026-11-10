// 验收追踪：把 req/brief/debug 的验收项与 plan、test、review 按稳定 ID 对齐。
// 只做确定性解析，不判断证据是否充分；旧产物无 ID 时按出现顺序回退。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './common.mjs';
import {
  checkboxes, isOptionPlaceholder, meaningful, section, tableHeader, tableRows,
} from './markdown.mjs';
import { detectFlow } from './review.mjs';

const ID_AT_START = /^\s*AC[-_ ]?(\d+)\b\s*[：:.\-]?\s*([\s\S]*)$/i;
const ID_ANYWHERE = /\bAC[-_ ]?\d+\b/gi;
const ID_COLUMN = /验收项|验收 ID|^AC/i;
const DEBUG_NOISE = /^现有测试\s*\/\s*代码契约\s*\/\s*需求文档\s*[：:]?$/;

function dedupe(list) {
  return [...new Set(list)];
}

function emptyTotals() {
  return {
    items: 0, covered: 0, accepted: 0, planned: 0, uncovered: 0, blocked: 0, gaps: 0,
  };
}

function normalizeId(raw) {
  const digits = /\d+/.exec(String(raw || ''));
  return digits ? `AC-${Number(digits[0])}` : null;
}

function splitId(raw) {
  const text = String(raw || '').trim();
  const match = ID_AT_START.exec(text);
  if (!match) return { explicit: false, id: null, text };
  return { explicit: true, id: `AC-${Number(match[1])}`, text: match[2].trim() };
}

function idsIn(cell) {
  const ids = (String(cell || '').match(ID_ANYWHERE) || []).map(normalizeId).filter(Boolean);
  return [...new Set(ids)];
}

function cell(row, index) {
  return index >= 0 ? String(row[index] || '').trim() : '';
}

function columnIndex(header, ...patterns) {
  if (!header) return -1;
  return header.findIndex((value) => patterns.some((pattern) => pattern.test(value)));
}

/** 解析 req/brief 的验收标准，或 debug 的「正确行为依据」。 */
function parseAcceptance(text, { source = 'req' } = {}) {
  const warnings = [];
  if (source === 'debug') {
    const body = section(text, '正确行为依据');
    if (body === null) return { found: false, items: [], warnings: ['缺少「## 正确行为依据」段落'] };
    const items = [];
    for (const line of body.split(/\r?\n/)) {
      const match = /^\s*[-*]\s+(.+)$/.exec(line);
      if (!match) continue;
      const parsed = splitId(match[1].trim());
      if (!meaningful(parsed.text) || DEBUG_NOISE.test(parsed.text)) continue;
      items.push({ ...parsed, checked: true });
    }
    return { found: true, items, warnings };
  }

  const body = section(text, '验收标准');
  if (body === null) return { found: false, items: [], warnings: ['缺少「## 验收标准」段落'] };
  const items = [];
  for (const item of checkboxes(body)) {
    const parsed = splitId(item.text);
    if (!meaningful(parsed.text)) {
      if (parsed.explicit) warnings.push(`验收项 ${parsed.id} 没有描述文本，已跳过`);
      continue;
    }
    items.push({ ...parsed, checked: item.checked });
  }
  return { found: true, items, warnings };
}

/** 给缺失或重复的显式 ID 补编号；不改变有意义的文本与勾选状态。 */
function assignIds(entries) {
  const warnings = [];
  const hasExplicit = entries.some((entry) => entry.explicit);
  const used = new Set();
  // 先保留全部显式 ID，避免无 ID 项抢占后面才出现的编号。
  const reserved = new Set(
    entries.filter((entry) => entry.explicit).map((entry) => entry.id),
  );
  let next = 1;

  const nextFree = () => {
    while (used.has(`AC-${next}`) || reserved.has(`AC-${next}`)) next += 1;
    const id = `AC-${next}`;
    next += 1;
    return id;
  };

  let mixed = false;
  const items = entries.map((entry) => {
    let id;
    if (entry.explicit) {
      id = entry.id;
      if (used.has(id)) {
        const reassigned = nextFree();
        warnings.push(`重复的验收 ID ${id}，已改为 ${reassigned}`);
        id = reassigned;
      }
    } else {
      id = nextFree();
      mixed = mixed || hasExplicit;
    }
    used.add(id);
    return { ...entry, id };
  });

  if (!hasExplicit && items.length) {
    warnings.push('旧产物未使用 AC ID，已按出现顺序推导');
  } else if (mixed) {
    warnings.push('部分验收项缺少 AC ID，已按顺序补齐');
  }
  return { items, warnings };
}

/** 解析 plan 的「任务拆分」或 brief 的「改动范围与测试计划」。 */
function parsePlanCoverage(text, { title = '任务拆分' } = {}) {
  if (!text) return { available: false, byId: {}, warnings: [] };
  const body = section(text, title);
  if (body === null) return { available: false, byId: {}, warnings: [`缺少「## ${title}」段落`] };
  const header = tableHeader(body);
  const rows = tableRows(body);
  if (!header || rows.length === 0) {
    return { available: false, byId: {}, warnings: [`「${title}」表格没有数据行`] };
  }
  const idColumn = columnIndex(header, ID_COLUMN);
  if (idColumn < 0) {
    return { available: false, byId: {}, warnings: [`「${title}」缺少「验收项」列`] };
  }
  const taskColumn = columnIndex(header, /任务/, /改动/);
  const fileColumn = columnIndex(header, /涉及文件/, /文件/);
  const statusColumn = columnIndex(header, /状态/);

  const byId = {};
  for (const row of rows) {
    const ids = idsIn(row[idColumn]);
    if (!ids.length) continue;
    const entry = {
      task: cell(row, taskColumn) || cell(row, 0),
      files: cell(row, fileColumn),
      status: cell(row, statusColumn),
    };
    for (const id of ids) (byId[id] ||= []).push(entry);
  }
  return { available: true, byId, warnings: [] };
}

const TEST_RESULT_OPTIONS = ['通过', '未覆盖'];
const REVIEW_STATUS_OPTIONS = ['阻断', '已覆盖', '未覆盖', '接受'];

function classifyTest(raw) {
  const value = String(raw || '').trim();
  if (!meaningful(value)) return null;
  // 「通过 / 未覆盖（原因）」这类模板选项行不是结论。
  if (isOptionPlaceholder(value, TEST_RESULT_OPTIONS)) return null;
  if (/^(未覆盖|未通过|失败|不适用)/i.test(value) || /^fail/i.test(value)) return 'uncovered';
  // “部分通过”不是完整覆盖，按未覆盖处理，避免被后面的“通过”兜底误判。
  if (/^部分(?:通过|完成)/.test(value)) return 'uncovered';
  if (/^(通过|已覆盖|成功)/.test(value) || /^(pass|covered)/i.test(value)) return 'covered';
  if (/未覆盖|未通过|失败|不适用|\bfail(?:ed|ure)?\b/i.test(value)) return 'uncovered';
  if (/通过|已覆盖|成功|\bpass(?:ed)?\b|\bcovered\b/i.test(value)) return 'covered';
  return 'unknown';
}

/** 解析 test.md 的「验收覆盖」表；无「验收项」列时按行序回退到验收项。 */
function parseTestCoverage(text, items = []) {
  if (!text) return { available: false, byId: {}, warnings: [] };
  const body = section(text, '验收覆盖');
  if (body === null) return { available: false, byId: {}, warnings: ['缺少「## 验收覆盖」小节'] };
  const header = tableHeader(body);
  const rows = tableRows(body);
  if (!header || rows.length === 0) {
    return { available: false, byId: {}, warnings: ['「验收覆盖」表格没有数据行'] };
  }
  const idColumn = columnIndex(header, ID_COLUMN);
  const evidenceColumn = columnIndex(header, /证据/, /测试/, /实现/);
  const resultColumn = columnIndex(header, /结论/, /结果/, /状态/);
  const positional = idColumn < 0;

  const byId = {};
  const warnings = [];
  rows.forEach((row, index) => {
    let ids;
    if (positional) {
      const item = items[index];
      if (!item) {
        warnings.push('「验收覆盖」行数多于验收项，多余行已忽略');
        return;
      }
      ids = [item.id];
    } else {
      ids = idsIn(row[idColumn]);
      if (!ids.length) return;
    }
    const result = classifyTest(cell(row, resultColumn));
    if (result === 'unknown') warnings.push(`无法识别的测试结论：${cell(row, resultColumn)}`);
    for (const id of ids) {
      byId[id] = {
        evidence: cell(row, evidenceColumn),
        result: cell(row, resultColumn),
        status: result,
        covered: result === 'covered',
      };
    }
  });
  if (positional && rows.length < items.length) {
    warnings.push(`「验收覆盖」缺少 ${items.length - rows.length} 条验收项`);
  }
  return { available: true, byId, warnings };
}

function classifyReview(raw) {
  const value = String(raw || '').trim();
  if (!meaningful(value)) return null;
  if (isOptionPlaceholder(value, REVIEW_STATUS_OPTIONS)) return null;
  if (/^(阻断|blocked)/i.test(value)) return 'blocked';
  if (/^未覆盖/.test(value)) return /接受|accepted/i.test(value) ? 'accepted' : 'uncovered';
  if (/^(已覆盖|通过)/.test(value) || /^(pass|covered)/i.test(value)) return 'covered';
  if (/^(接受|accepted)/i.test(value)) return 'accepted';
  // 结论词不在开头时按出现顺序兜底。
  if (/阻断|blocked/i.test(value)) return 'blocked';
  if (/未覆盖/.test(value)) return /接受|accepted/i.test(value) ? 'accepted' : 'uncovered';
  if (/已覆盖|通过|pass|covered/i.test(value)) return 'covered';
  return 'unknown';
}

/** 解析 review.md 的「验收对照」表；旧表头按行序回退到验收项。 */
export function parseReviewCoverage(text, items = []) {
  if (!text) return { available: false, byId: {}, warnings: [] };
  const body = section(text, '验收对照');
  if (body === null) return { available: false, byId: {}, warnings: ['缺少「## 验收对照」段落'] };
  const header = tableHeader(body);
  const rows = tableRows(body);
  if (!header || rows.length === 0) {
    return { available: false, byId: {}, warnings: ['「验收对照」表格没有数据行'] };
  }
  const idColumn = header.findIndex((value) => /验收项|验收 ID|^AC/i.test(value));
  const statusColumn = columnIndex(header, /状态/, /结论/);
  const evidenceColumn = columnIndex(header, /实现/, /证据/, /测试/);
  const positional = idColumn < 0;

  const byId = {};
  const warnings = [];
  rows.forEach((row, index) => {
    let ids;
    if (positional) {
      const item = items[index];
      if (!item) {
        warnings.push('「验收对照」行数多于验收项，多余行已忽略');
        return;
      }
      ids = [item.id];
    } else {
      ids = idsIn(row[idColumn]);
      if (!ids.length) return;
    }
    const status = classifyReview(cell(row, statusColumn));
    if (status === 'unknown') warnings.push(`无法识别的验收状态：${cell(row, statusColumn)}`);
    for (const id of ids) {
      byId[id] = {
        evidence: cell(row, evidenceColumn),
        status,
        raw: cell(row, statusColumn),
      };
    }
  });
  if (positional && rows.length < items.length) {
    warnings.push(`「验收对照」缺少 ${items.length - rows.length} 条验收项`);
  }
  return { available: true, byId, warnings };
}

const SEVERITY = ['blocked', 'covered', 'accepted', 'planned', 'uncovered'];

export function buildTrace({ flow, source, texts = {} }) {
  const acceptance = parseAcceptance(texts.acceptance || '', { source });
  if (!acceptance.found) {
    return {
      flow,
      source,
      skipped: true,
      reason: acceptance.warnings[0] || '缺少验收来源',
      items: [],
      totals: emptyTotals(),
      missing: [],
      warnings: acceptance.warnings,
    };
  }

  const assigned = assignIds(acceptance.items);
  const explicitIds = assigned.items.some((item) => item.explicit);
  const warnings = [...acceptance.warnings, ...assigned.warnings];
  if (!assigned.items.length) {
    return {
      flow,
      source,
      skipped: true,
      reason: '没有可追踪的验收项（可能仍是模板占位）',
      items: [],
      totals: emptyTotals(),
      missing: [],
      warnings,
    };
  }

  const planTitle = source === 'brief' ? '改动范围与测试计划' : '任务拆分';
  const plan = source === 'debug'
    ? { available: false, byId: {}, warnings: [] }
    : parsePlanCoverage(texts.plan || '', { title: planTitle });
  const test = parseTestCoverage(texts.test || '', assigned.items);
  const review = parseReviewCoverage(texts.review || '', assigned.items);
  warnings.push(...plan.warnings, ...test.warnings, ...review.warnings);

  const known = new Set(assigned.items.map((item) => item.id));
  const references = { plan: [], test: [], review: [] };
  for (const [key, sourceMap, label] of [
    ['plan', plan.byId, '任务表'],
    ['test', test.byId, '测试覆盖'],
    ['review', review.byId, '验收对照'],
  ]) {
    for (const id of Object.keys(sourceMap)) {
      if (!known.has(id)) {
        warnings.push(`${label}引用了未定义的验收 ID ${id}`);
        references[key].push(id);
      }
    }
  }

  const items = assigned.items.map((item) => {
    const planRows = plan.byId[item.id] || [];
    const testRow = test.byId[item.id] || null;
    const reviewRow = review.byId[item.id] || null;
    const testStatus = testRow?.status;
    const reviewStatus = reviewRow?.status;
    const conflict = (testStatus === 'covered'
      && ['blocked', 'accepted', 'uncovered'].includes(reviewStatus))
      || (testStatus === 'uncovered' && reviewStatus === 'covered');
    if (conflict) {
      warnings.push(`${item.id} 的测试结论与 review 不一致，以 review 为准`);
    }
    let status;
    // 审查结论是最终裁决：review 说未覆盖时，不能因为测试通过就判为已覆盖。
    if (reviewStatus === 'blocked') status = 'blocked';
    else if (['covered', 'accepted', 'uncovered'].includes(reviewStatus)) status = reviewStatus;
    else if (testRow?.covered) status = 'covered';
    else if (planRows.length) status = 'planned';
    else status = 'uncovered';

    return {
      id: item.id,
      text: item.text,
      checked: item.checked,
      plan: planRows,
      test: testRow,
      review: reviewRow,
      status,
    };
  });

  const totals = emptyTotals();
  totals.items = items.length;
  for (const item of items) {
    if (SEVERITY.includes(item.status)) totals[item.status] += 1;
  }
  totals.gaps = totals.planned + totals.uncovered + totals.blocked;
  const missing = items
    .filter((item) => ['planned', 'uncovered', 'blocked'].includes(item.status))
    .map((item) => item.id);

  return {
    flow,
    source,
    skipped: false,
    explicitIds,
    references,
    items,
    totals,
    missing,
    warnings: dedupe(warnings),
    sources: { plan: plan.available, test: test.available, review: review.available },
  };
}

/** 读取 docs/devflow/<slug>/ 下的产物并生成追踪结果。 */
export function traceFor(root, slug) {
  const flow = detectFlow(root, slug);
  const dir = join(root, 'docs', 'devflow', slug);
  const config = {
    full: { source: 'req', acceptance: 'req.md', plan: 'plan.md' },
    'light-feature': { source: 'brief', acceptance: 'brief.md', plan: 'brief.md' },
    'light-bug': { source: 'debug', acceptance: 'debug.md', plan: null },
  }[flow];

  if (!config) {
    return {
      slug,
      flow,
      source: null,
      skipped: true,
      reason: '无法识别流程（缺少 req.md / brief.md / debug.md）',
      items: [],
      totals: emptyTotals(),
      missing: [],
      warnings: [],
    };
  }

  const read = (name) => {
    if (!name) return null;
    const file = join(dir, name);
    return existsSync(file) ? readText(file) : null;
  };

  const acceptance = read(config.acceptance);
  if (!acceptance) {
    return {
      slug,
      flow,
      source: config.source,
      skipped: true,
      reason: `缺少验收来源 ${config.acceptance}`,
      items: [],
      totals: emptyTotals(),
      missing: [],
      warnings: [],
    };
  }

  const texts = {
    acceptance,
    plan: read(config.plan),
    test: read('test.md'),
    review: read('review.md'),
  };
  const result = buildTrace({ flow, source: config.source, texts });
  const missingFiles = [];
  if (config.plan && texts.plan === null) missingFiles.push(config.plan);
  if (texts.test === null) missingFiles.push('test.md');
  if (texts.review === null) missingFiles.push('review.md');
  result.warnings = dedupe([
    ...missingFiles.map((name) => `缺少 ${name}`),
    ...(result.warnings || []),
  ]);
  return { slug, flow, ...result };
}

export function summarizeTrace(result) {
  return {
    source: result.source,
    total: result.totals?.items || 0,
    covered: result.totals?.covered || 0,
    gaps: result.totals?.gaps || 0,
    gapIds: result.missing || [],
    accepted: result.totals?.accepted || 0,
    blocked: result.totals?.blocked || 0,
    skipped: Boolean(result.skipped),
  };
}
