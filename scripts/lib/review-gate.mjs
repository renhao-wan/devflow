import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './common.mjs';
import {
  bulletValue, isOptionPlaceholder, meaningful, section, tableDataRows, tableHeader,
} from './markdown.mjs';
import { DIRECTION_LABELS } from './review.mjs';
import { parseReviewCoverage, summarizeTrace, traceFor } from './trace.mjs';

const TRIGGER_OPTIONS = ['mandatory', 'required', 'auto', 'user', 'skipped'];
const LEVEL_OPTIONS = ['low', 'medium', 'high', 'special'];

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
export function checkReviewReport(root, slug, { triage = null, trace = null } = {}) {
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

  // 验收追踪只做提示：旧产物可能按顺序回退，硬失败交给 devflow trace --check。
  const fullTrace = trace || traceFor(root, slug);
  const traceSummary = summarizeTrace(fullTrace);
  const acceptanceBody = section(text, '验收对照');
  if (acceptanceBody === null) {
    warnings.push('缺少「## 验收对照」段落');
  } else {
    const header = tableHeader(acceptanceBody) || [];
    const hasIdColumn = header.some((value) => /验收项|验收 ID|^AC/i.test(value));
    const hasStatusColumn = header.some((value) => /状态|结论/.test(value));
    if (!hasStatusColumn) {
      warnings.push('「验收对照」缺少「状态」列，无法核对结论');
    } else if (!hasIdColumn) {
      warnings.push('「验收对照」未按验收项列表头，已按行序回退映射；建议改为按验收 ID 逐条填写');
    }
    for (const warning of parseReviewCoverage(text, fullTrace.items || []).warnings) {
      if (warning.startsWith('无法识别的验收状态') && !warnings.includes(warning)) warnings.push(warning);
    }
  }
  if (!traceSummary.skipped && traceSummary.gaps > 0) {
    const ids = traceSummary.gapIds.slice(0, 5).join('、');
    const more = traceSummary.gapIds.length > 5 ? ' 等' : '';
    warnings.push(`验收跟踪存在 ${traceSummary.gaps} 项缺口（${ids}${more}）；运行 devflow trace --slug ${slug} --check 核对`);
  }
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

  if (triage?.scope?.mode === 'incremental') {
    // 增量复审只缩小 diff 范围，不降低验收与阻断义务；旧问题必须逐项交代去向。
    const body = section(text, '增量复审');
    const disposition = body === null ? { found: false, value: '' } : bulletValue(body, '旧阻断项处置');
    // isOptionPlaceholder 依赖 \b，对中文选项无效，这里直接数命中的选项。
    const optionHits = ['沿用', '已修复', '失效']
      .filter((option) => disposition.value.includes(option)).length;
    if (body === null || !meaningful(body)) {
      errors.push('增量复审缺少「## 增量复审」小节，需写明本次改动范围与旧阻断项处置');
    } else if (!disposition.found || !meaningful(disposition.value) || optionHits >= 3) {
      errors.push('「增量复审」缺少「旧阻断项处置」（逐项写明沿用 / 已修复 / 失效）');
    } else {
      checks.incremental = { since: triage.scope.since ?? null };
      if (!/沿用|已修复|失效|关闭/.test(disposition.value)) {
        warnings.push('「旧阻断项处置」未使用 沿用 / 已修复 / 失效 表述');
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, checks };
}
