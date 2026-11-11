/**
 * 流程产物链的单一真源：status 的过期提示与 change 的归档清单都从这里取规则。
 * 只描述“阶段对应哪些文件”，不读文件、不判断门禁，方便注入 mtime 与做纯函数测试。
 */

/** 任务目录里可能出现的阶段产物；顺序与完整流程一致。 */
export const ARTIFACTS = ['req.md', 'plan.md', 'brief.md', 'debug.md', 'test.md', 'review.md'];

/** 能单独构成任务入口的产物；slug 解析用这一份，避免与流程识别漂移。 */
export const ENTRY_ARTIFACTS = ['req.md', 'plan.md', 'brief.md', 'debug.md'];

/** 各流程的阶段产物链；review-triage.json 是 review.md 的附属，不单独入链。 */
export const FLOWS = {
  full: ['req.md', 'plan.md', 'test.md', 'review.md'],
  'light-feature': ['brief.md', 'test.md', 'review.md'],
  'light-bug': ['debug.md', 'test.md', 'review.md'],
};

/** 用户可能按实际文件名传起点；统一规范化为 req。 */
const FROM_ALIASES = { brief: 'req', debug: 'req' };

export const FROM_STAGES = ['req', 'plan', 'test', 'review'];

/** 下游过期判定的容差：同一次写入/连续操作造成的毫秒差不应误报。 */
export const STALE_TOLERANCE_MS = 1000;

export function normalizeFrom(from) {
  const value = String(from ?? '').trim();
  return FROM_ALIASES[value] || value;
}

/** 完整流程优先：只要出现 req.md 或 plan.md，就按完整任务处理。 */
export function flowOf(files = []) {
  const has = (name) => files.includes(name);
  if (has('req.md') || has('plan.md')) return 'full';
  if (has('brief.md')) return 'light-feature';
  if (has('debug.md')) return 'light-bug';
  return 'unknown';
}

export function chainOf(flow) {
  return FLOWS[flow] ? [...FLOWS[flow]] : [];
}

/** 起点阶段的文件名；用于 change 的前置校验，避免在异常目录上归档出空任务。 */
export function startFileFor(flow) {
  const chain = chainOf(flow);
  return chain.length ? chain[0] : null;
}

function stageIndex(chain, stage) {
  if (stage === 'req') return chain.length ? 0 : -1;
  const file = `${stage}.md`;
  // 轻量流程的 plan 不在链上，indexOf 会返回 -1，由调用方给出更明确的错误。
  return chain.indexOf(file);
}

/**
 * 计算归档清单。
 * - req / plan：保留自身（供修改），归档下游；--purge 时连自身一起归档。
 * - test / review：归档自身及下游（执行记录重做时应重新生成）；--purge 不改变行为。
 * - review.md 归档时始终带上 review-triage.json，避免留下过期的审查快照。
 */
export function archivePlanFor(flow, from, { purge = false } = {}) {
  const stage = normalizeFrom(from);
  if (!FROM_STAGES.includes(stage)) {
    return { error: `未知的 --from：${from || '（空）'}；可选 req、plan、test、review` };
  }
  const chain = chainOf(flow);
  if (!chain.length) {
    return { error: '无法识别流程；请确认 docs/devflow/<slug>/ 下是否有 req.md、brief.md 或 debug.md' };
  }
  if (flow !== 'full' && stage === 'plan') {
    return { error: '轻量流程没有 plan 阶段；改 brief/debug 用 --from req，重跑测试用 --from test' };
  }
  const index = stageIndex(chain, stage);
  if (index < 0) return { error: `当前流程没有 ${stage} 阶段` };

  const selfArchived = stage === 'test' || stage === 'review'
    || (purge && (stage === 'req' || stage === 'plan'));
  const start = selfArchived ? index : index + 1;
  const files = [];
  for (const file of chain.slice(start)) {
    files.push(file);
    if (file === 'review.md') files.push('review-triage.json');
  }
  return {
    files,
    keep: chain.slice(0, start),
    stage,
    flow,
    selfArchived,
  };
}

/**
 * 只比较链上相邻两项：输出可解释，并会随着用户重跑逐步引导到更下游。
 * mtimes 是文件名到毫秒时间戳的映射；缺失或为 0 的项直接跳过。
 * from 是该过期关系最小的归档起点：注意 test.md 对应 review，
 * 因为 test 晚于 review 时只需归档旧审查，不能把刚更新的测试记录一起归档。
 */
export function staleDownstream(chain, mtimes = {}, { tolerance = STALE_TOLERANCE_MS } = {}) {
  const stale = [];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const upstream = chain[i];
    const downstream = chain[i + 1];
    const up = Number(mtimes[upstream]) || 0;
    const down = Number(mtimes[downstream]) || 0;
    if (!up || !down) continue;
    if (up - down > tolerance) {
      stale.push({
        upstream,
        downstream,
        upstreamAt: up,
        downstreamAt: down,
        from: changeFromFor(upstream),
      });
    }
  }
  return stale;
}

/**
 * --purge 从链首重开时，任务目录里其他流程的入口产物也应一起归档。
 * 例如完整任务里追加的 debug.md，不归档会让 status 把任务重新识别成轻量修复。
 */
export function purgeRemainder(files = [], keep = []) {
  if (keep.length) return [];
  return ARTIFACTS.filter((name) => files.includes(name) && !keep.includes(name));
}

/** 上游产物对应的最小归档起点；light 流程的 brief/debug 统一回落到 req。 */
export function changeFromFor(upstream) {
  const file = String(upstream ?? '');
  if (file === 'req.md' || file === 'brief.md' || file === 'debug.md') return 'req';
  if (file === 'plan.md') return 'plan';
  // test 晚于 review 时只归档 review；--from test 会连测试记录一起归档。
  if (file === 'test.md') return 'review';
  return null;
}

/** 过期关系的稳定指纹；用于 --ack 后判断产物是否又发生了变化。 */
export function staleKey(entries = []) {
  return entries
    .map((entry) => `${entry.upstream}@${entry.upstreamAt}>${entry.downstream}@${entry.downstreamAt}`)
    .join('|');
}

/** 标题规范化：忽略空白、标点、大小写与轻量后缀，只用于“是否像同一个任务”的保守判断。 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/[（(]\s*轻量功能\s*[)）]\s*$/u, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/**
 * 找出标题规范化后完全相同的任务。
 * 只做精确匹配，避免相似度算法在正常任务间制造噪声；占位标题直接跳过。
 */
export function duplicateGroups(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const raw = String(entry.title ?? '').trim();
    if (!raw || /^<[^>]+>$/.test(raw)) continue;
    const key = normalizeTitle(raw);
    if (key.length < 2) continue;
    if (!groups.has(key)) groups.set(key, { titles: [], slugs: [] });
    groups.get(key).titles.push(raw);
    groups.get(key).slugs.push(entry.slug);
  }
  return [...groups.values()]
    .filter((group) => group.slugs.length > 1)
    .map((group) => ({
      // 取最短的原始标题作为展示值，避免结果依赖扫描顺序，也去掉“（轻量功能）”这类后缀。
      title: [...group.titles].sort((a, b) => a.length - b.length || a.localeCompare(b))[0],
      slugs: [...group.slugs].sort(),
    }));
}
