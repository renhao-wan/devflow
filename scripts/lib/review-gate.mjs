import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './common.mjs';
import { DIRECTION_LABELS } from './review.mjs';

const TRIGGER_OPTIONS = ['mandatory', 'required', 'auto', 'user', 'skipped'];
const LEVEL_OPTIONS = ['low', 'medium', 'high', 'special'];

function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    return m && m[1] === title;
  });
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** 读取 `- 字段：值` 形式的行；值可换成下一行起的缩进子条目。 */
function bulletValue(body, label) {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/^\s*[-*]\s+/, '').trim();
    if (!stripped.startsWith(label)) continue;
    // 标签后可能跟括号说明或补充文字，统一取到第一个冒号为止。
    const rest = stripped.slice(label.length);
    const colon = rest.search(/[：:]/);
    if (colon < 0) continue;
    let value = rest.slice(colon + 1).trim();
    const parts = [];
    if (!value) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) break;
        if (!/^\s+/.test(lines[j])) break;
        parts.push(lines[j].replace(/^\s*[-*]\s+/, '').trim());
      }
      value = parts.filter(Boolean).join('；');
    }
    return { found: true, value };
  }
  return { found: false, value: '' };
}

/** 模板原样保留的选项行（例如 `low / medium / high / special`）视为未填写。 */
function isOptionPlaceholder(value, options) {
  const hits = options.filter((option) => new RegExp(`\\b${option}\\b`, 'i').test(value)).length;
  return hits >= Math.min(3, options.length);
}

function tableDataRows(body) {
  const rows = body.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  if (rows.length <= 1) return 0;
  let count = 0;
  // 第一行是表头；其余行只要存在非空单元格就算数据行。
  for (const row of rows.slice(1)) {
    const cells = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
    if (cells.every((cell) => !cell || /^:?-{2,}:?$/.test(cell))) continue;
    count += 1;
  }
  return count;
}

function directionOf(item) {
  return typeof item === 'string' ? item : item?.direction;
}

function mentions(text, direction) {
  const label = DIRECTION_LABELS[direction];
  return Boolean(text) && (text.includes(direction) || (label && text.includes(label)));
}

/**
 * 校验 review.md 是否完成了 triage 要求的审查记录。
 * 只做确定性检查：结论、未关闭阻断项、画像字段与 triage 快照的一致性。
 */
export function checkReviewReport(root, slug, { triage = null } = {}) {
  const file = join(root, 'docs', 'devflow', slug, 'review.md');
  const errors = [];
  const warnings = [];
  const checks = {};

  if (!existsSync(file)) {
    return { ok: false, errors: ['缺少 review.md'], warnings, checks };
  }

  const text = readText(file);

  let deliverable = false;
  const conclusionBody = section(text, '结论');
  if (conclusionBody === null) {
    errors.push('缺少「## 结论」段落');
  } else {
    const deliver = /^\s*[-*]\s*\[[xX]\]\s*可以交付/m.test(conclusionBody);
    const redo = /^\s*[-*]\s*\[[xX]\]\s*修复阻断项后再审/m.test(conclusionBody);
    deliverable = deliver && !redo;
    checks.conclusion = { deliver, redo };
    if (!deliver && !redo) {
      errors.push('「结论」尚未勾选');
    } else if (deliver && redo) {
      errors.push('「结论」同时勾选了「可以交付」与「修复阻断项后再审」');
    } else if (redo) {
      errors.push('「结论」为修复阻断项后再审，审查尚未完成');
    }
  }

  const blockingBody = section(text, '阻断项');
  if (blockingBody === null) {
    warnings.push('缺少「## 阻断项」段落，无法确认是否有未关闭问题');
  } else {
    const rows = tableDataRows(blockingBody);
    checks.blockingRows = rows;
    if (deliverable && rows > 0) {
      errors.push(`「阻断项」仍有 ${rows} 项未关闭，不能标记为可以交付`);
    }
  }

  if (section(text, '验收对照') === null) warnings.push('缺少「## 验收对照」段落');
  if (section(text, '复用与依赖检查') === null) warnings.push('缺少「## 复用与依赖检查」段落');

  if (!triage) {
    warnings.push('缺少 review-triage.json，无法核对审查画像');
  } else if (triage.trigger === 'skipped') {
    const body = section(text, '审查触发与画像');
    if (body === null) {
      errors.push('trigger=skipped 时缺少「## 审查触发与画像」段落');
    } else {
      const baseline = bulletValue(body, '跳过时');
      const mentionsSkip = /跳过|skipped/i.test(body);
      checks.skipped = { mentionsSkip, baseline: baseline.value };
      if (!mentionsSkip || !baseline.value) {
        errors.push('trigger=skipped 时必须写明跳过依据与基线检查结论');
      }
    }
  } else {
    const body = section(text, '审查触发与画像');
    if (body === null) {
      errors.push('缺少「## 审查触发与画像」段落');
    } else {
      const trigger = bulletValue(body, '触发');
      if (!trigger.found || !trigger.value) {
        errors.push('画像缺少「触发」结果');
      } else if (isOptionPlaceholder(trigger.value, TRIGGER_OPTIONS)) {
        errors.push('画像「触发」仍是模板选项，未填写实际结果');
      } else if (!trigger.value.toLowerCase().includes(String(triage.trigger).toLowerCase())) {
        errors.push(`画像触发与 triage 不一致（triage=${triage.trigger}）`);
      }

      const level = bulletValue(body, '风险等级');
      if (triage.level) {
        if (!level.found || !level.value) {
          errors.push('画像缺少「风险等级」');
        } else if (isOptionPlaceholder(level.value, LEVEL_OPTIONS)) {
          errors.push('画像「风险等级」仍是模板选项，未填写实际等级');
        } else if (!level.value.toLowerCase().includes(String(triage.level).toLowerCase())) {
          errors.push(`画像风险等级与 triage 不一致（triage=${triage.level}）`);
        }
      }

      const selected = bulletValue(body, '选中方向');
      const selectedDirections = (triage.selected || []).map(directionOf).filter(Boolean);
      checks.selected = selectedDirections;
      if (!selected.value) {
        errors.push('画像缺少「选中方向」');
      } else {
        for (const direction of selectedDirections) {
          if (!mentions(selected.value, direction)) {
            errors.push(`画像「选中方向」缺少 ${DIRECTION_LABELS[direction] || direction}`);
          }
        }
      }

      if ((triage.assignments || []).length) {
        const assigned = bulletValue(body, '实际派单');
        if (!assigned.value) errors.push('画像缺少「实际派单」');
      }

      const deferred = bulletValue(body, '主上下文补查');
      for (const direction of (triage.deferred || []).map(directionOf).filter(Boolean)) {
        if (!mentions(deferred.value, direction)) {
          errors.push(`画像「主上下文补查」缺少 ${DIRECTION_LABELS[direction] || direction}`);
        }
      }

      if ((triage.excluded || []).length) {
        const excluded = bulletValue(body, '排除方向');
        if (!excluded.value) errors.push('画像缺少「排除方向与理由」');
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, checks };
}
