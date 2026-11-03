import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readText } from './common.mjs';

export const DIRECTIONS = [
  'correctness',
  'security',
  'data',
  'concurrency',
  'acceptance',
  'deps',
  'tests',
  'maintainability',
];

export const DIRECTION_LABELS = {
  correctness: '正确性',
  security: '安全',
  data: '数据与迁移',
  concurrency: '并发与状态',
  acceptance: '验收与回归',
  deps: '依赖与供应链',
  tests: '测试质量',
  maintainability: '可维护性',
};

/** 代理分组：相关方向合并，异质方向分开，避免重复劳动。 */
export const AGENT_GROUPS = [
  { id: 'A', directions: ['correctness', 'concurrency'] },
  { id: 'B', directions: ['security', 'deps'] },
  { id: 'C', directions: ['acceptance', 'tests'] },
  { id: 'D', directions: ['data'] },
  { id: 'E', directions: ['maintainability'] },
];

export const AGENT_CAP = {
  low: 0,
  medium: 1,
  high: 2,
  special: 4,
};

export const USER_AGENT_CAP = 4;

/**
 * 路径规则：命中即给方向加分。
 * weight 3 表示高危（认证、支付、密钥、迁移、并发原语），2 表示结构性风险，1 表示提示。
 */
const PATH_RULES = [
  {
    re: /(^|\/)(auth|oauth|oauth2|login|logout|session|sessions|permission|permissions|acl|rbac|authz|authn)([./_-]|$)/i,
    direction: 'security',
    weight: 3,
    reason: '认证或权限路径',
  },
  {
    re: /(^|\/)(payment|billing|checkout|refund|invoice|wallet)([./_-]|$)/i,
    direction: 'security',
    weight: 3,
    reason: '支付或交易路径',
  },
  {
    re: /(^|\/)(secret|secrets|credential|credentials|crypto|keys?|tokens?)([./_-]|$)/i,
    direction: 'security',
    weight: 3,
    reason: '密钥、凭据或加密路径',
  },
  {
    re: /(^|\/)(migrations?|migrate|schema|schemas|ddl|database|db)([./_-]|$)|\.(sql|prisma)$/i,
    direction: 'data',
    weight: 3,
    reason: '数据、schema 或迁移路径',
  },
  {
    re: /(^|\/)(lock|mutex|semaphore|transaction|transactions|concurrency|atomic)([./_-]|$)/i,
    direction: 'concurrency',
    weight: 3,
    reason: '并发或事务路径',
  },
  {
    re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|Gemfile(\.lock)?)$/i,
    direction: 'deps',
    weight: 2,
    reason: '依赖清单变化',
  },
  {
    re: /(^|\/)(api|apis|contract|contracts|openapi|swagger|proto|protobuf|graphql)([./_-]|$)|\.(proto|graphql|gql)$/i,
    direction: 'acceptance',
    weight: 2,
    reason: '公共接口或契约',
  },
  {
    re: /(^|\/)(__tests__|tests?|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/i,
    direction: 'tests',
    weight: 1,
    reason: '测试文件变化',
  },
];

/** 内容规则：只扫描 diff 的新增/删除行，避免整文件误报。 */
const CONTENT_RULES = [
  {
    re: /\b(eval|Function)\s*\(|\bexecSync\b|\bexecFileSync\b|\bchild_process\b|shell\s*=\s*True|dangerouslySetInnerHTML|innerHTML\s*=/,
    direction: 'security',
    weight: 2,
    reason: '动态执行或 HTML 注入面',
  },
  {
    re: /\b(Authorization|Bearer|password|passwd|secret|(api|access|refresh)[_-]?key|(api|access|refresh|id)[_-]?token|private[_-]?key)\b/i,
    direction: 'security',
    weight: 2,
    reason: '凭据相关标识',
  },
  {
    re: /\b(ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|CREATE\s+INDEX|UPDATE\s+\w+\s+SET)\b/i,
    direction: 'data',
    weight: 3,
    reason: '结构性数据变更',
  },
  {
    re: /\b(schema[_-]?version|migration|backfill|data[_-]?migration)\b/i,
    direction: 'data',
    weight: 2,
    reason: '迁移或回填逻辑',
  },
  {
    re: /\b(mutex|lock\(|tryLock|transaction|atomic|race|goroutine|Promise\.all)\b/i,
    direction: 'concurrency',
    weight: 2,
    reason: '并发原语或并行执行',
  },
  {
    re: /\b(breaking|deprecated|backward[s]?[_-]?compat|public[_-]?api|contract)\b/i,
    direction: 'acceptance',
    weight: 2,
    reason: '兼容性或公共契约变化',
  },
  {
    re: /\b(TODO|FIXME|HACK|eslint-disable|@ts-ignore|@ts-expect-error)\b/,
    direction: 'maintainability',
    weight: 1,
    reason: '遗留标记或抑制检查',
  },
];

const DOC_PATTERN = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|txt)$/i;
const GENERATED_PATTERN = /(^|\/)(dist|build|coverage|node_modules)(\/|$)|\.(min|map)$/i;

function addSignal(map, signal) {
  const entry = map.get(signal.direction) || { score: 0, rules: new Set(), files: new Set(), reasons: new Set() };
  const key = signal.reason;
  if (!entry.rules.has(key)) {
    entry.rules.add(key);
    entry.score += signal.weight;
  }
  entry.files.add(signal.path);
  entry.reasons.add(signal.reason);
  map.set(signal.direction, entry);
}

function scanPath(file, map) {
  const path = String(file.path || '').replace(/\\/g, '/');
  if (!path || GENERATED_PATTERN.test(path)) return;
  for (const rule of PATH_RULES) {
    if (rule.re.test(path)) {
      addSignal(map, { direction: rule.direction, weight: rule.weight, reason: rule.reason, path });
    }
  }
}

function scanDiff(text, map) {
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      current = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff ')) continue;
    if (!/^[+-]/.test(line)) continue;
    const body = line.slice(1);
    for (const rule of CONTENT_RULES) {
      if (rule.re.test(body)) {
        addSignal(map, {
          direction: rule.direction,
          weight: rule.weight,
          reason: rule.reason,
          path: current || '(unknown)',
        });
      }
    }
  }
}

/**
 * 风险画像纯函数：不读文件、不跑 git，方便单测与复用。
 * files: [{ path, additions, deletions, untracked }]
 */
export function profileChanges({
  files = [],
  diffText = '',
  focus = [],
  agents = null,
  noSubagents = false,
  focusOnly = false,
} = {}) {
  const map = new Map();
  const normalizedFiles = files.map((file) => ({
    path: String(file.path || '').replace(/\\/g, '/'),
    additions: Number(file.additions) || 0,
    deletions: Number(file.deletions) || 0,
    untracked: Boolean(file.untracked),
  }));

  for (const file of normalizedFiles) scanPath(file, map);
  scanDiff(diffText, map);

  const changedLines = normalizedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const codeFiles = normalizedFiles.filter((f) => !DOC_PATTERN.test(f.path) && !GENERATED_PATTERN.test(f.path));
  const testFiles = normalizedFiles.filter((f) => /(\.test\.|\.spec\.|__tests__|\/tests?\/)/i.test(f.path));

  // 多文件命中同一方向只小幅加分，防止“文件多”被误判为高危。
  for (const [direction, entry] of map) {
    const bonus = Math.min(Math.max(entry.files.size - 1, 0), 2);
    entry.score += bonus;
    entry.bonus = bonus;
  }

  const ranked = [...map.entries()]
    .map(([direction, entry]) => ({
      direction,
      score: entry.score,
      reasons: [...entry.reasons],
      files: [...entry.files].slice(0, 8),
      bonus: entry.bonus || 0,
    }))
    .sort((a, b) => b.score - a.score || DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction));

  const maxScore = ranked.length ? ranked[0].score : 0;
  const highDirections = ranked.filter((r) => r.score >= 3).length;
  let level = 'low';
  if (maxScore >= 5 || highDirections >= 2) level = 'special';
  else if (maxScore >= 3) level = 'high';
  else if (maxScore >= 1 || codeFiles.length >= 4 || changedLines >= 30) level = 'medium';

  const focusList = [...new Set(focus)].filter((d) => DIRECTIONS.includes(d));
  const userSpecified = focusList.length > 0;

  let cap = AGENT_CAP[level];
  let capSource = 'default';
  if (noSubagents) {
    cap = 0;
    capSource = 'none';
  } else if (agents !== null && agents !== undefined && Number.isFinite(Number(agents))) {
    cap = Math.max(0, Math.min(USER_AGENT_CAP, Math.trunc(Number(agents))));
    capSource = 'user';
  } else if (userSpecified) {
    cap = Math.min(USER_AGENT_CAP, focusList.length);
    capSource = 'user-focus';
  }

  const excluded = [];
  let selected = [];
  if (userSpecified) {
    selected = ranked.filter((r) => focusList.includes(r.direction));
    for (const direction of focusList) {
      if (!selected.some((r) => r.direction === direction)) {
        selected.push({ direction, score: 0, reasons: ['用户指定'], files: [], bonus: 0 });
      }
    }
    selected = selected.slice(0, cap);
    const selectedDirections = new Set(selected.map((r) => r.direction));
    // 用户点名但被上限截掉的方向必须留痕，不能当成没提过。
    for (const direction of focusList) {
      if (selectedDirections.has(direction)) continue;
      const known = ranked.find((r) => r.direction === direction);
      excluded.push({
        ...(known || { direction, score: 0, reasons: ['用户指定'], files: [], bonus: 0 }),
        reason: `超出代理上限 ${cap}`,
      });
    }
    for (const r of ranked) {
      if (!focusList.includes(r.direction)) {
        excluded.push({ ...r, reason: `用户指定 ${focusList.join('、')}，其余方向让位` });
      }
    }
  } else if (focusOnly) {
    selected = [];
    for (const r of ranked) {
      excluded.push({ ...r, reason: '仅执行主阶段基线检查（--focus-only）' });
    }
  } else {
    for (const r of ranked) {
      if (r.score < 1) continue;
      if (r.direction === 'maintainability') {
        excluded.push({ ...r, reason: '低风险，主阶段基线检查覆盖；需要时用 --focus maintainability' });
        continue;
      }
      if (r.direction === 'tests') {
        excluded.push({ ...r, reason: '测试质量由主阶段基线检查；需要时用 --focus tests' });
        continue;
      }
      if (r.direction === 'acceptance' && !['high', 'special'].includes(level)) {
        excluded.push({ ...r, reason: '验收对照由主阶段完成；高风险时才会派代理' });
        continue;
      }
      selected.push(r);
    }
    selected = selected.slice(0, cap);
  }

  const selectedDirections = new Set(selected.map((r) => r.direction));
  // 未入选方向显式记为排除，避免“没派代理”被误读成“已覆盖”。
  const excludedDirections = new Set(excluded.map((r) => r.direction));
  for (const r of ranked) {
    if (selectedDirections.has(r.direction) || excludedDirections.has(r.direction)) continue;
    excluded.push({
      ...r,
      reason: cap === 0 ? '风险等级低，主阶段基线检查覆盖' : `超出代理上限 ${cap}`,
    });
  }
  const assignments = AGENT_GROUPS
    .map((group) => ({
      agent: group.id,
      directions: group.directions.filter((d) => selectedDirections.has(d)),
    }))
    .filter((group) => group.directions.length > 0);

  // 未落入预设分组的方向单独成组，避免静默丢弃。
  const grouped = new Set(assignments.flatMap((g) => g.directions));
  for (const r of selected) {
    if (!grouped.has(r.direction)) assignments.push({ agent: `X${r.direction}`, directions: [r.direction] });
  }

  return {
    level,
    maxAgents: cap,
    capSource,
    selected,
    excluded,
    assignments,
    ranked,
    stats: {
      files: normalizedFiles.length,
      codeFiles: codeFiles.length,
      testFiles: testFiles.length,
      changedLines,
      untracked: normalizedFiles.filter((f) => f.untracked).length,
    },
  };
}

export function readReviewMarker(root, slug) {
  const file = join(root, 'docs', 'devflow', slug, 'debug.md');
  if (!existsSync(file)) return null;
  try {
    const head = readText(file).split(/\r?\n/).slice(0, 10).join('\n');
    const m = /^review:\s*['"]?(required|skipped)['"]?\s*$/m.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function detectFlow(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  const has = (name) => existsSync(join(dir, name));
  if (has('req.md') || has('plan.md')) return 'full';
  if (has('brief.md')) return 'light-feature';
  if (has('debug.md')) return 'light-bug';
  return 'unknown';
}

/** 从 git 收集工作区或分支差异；base 为空时比较 HEAD（工作区 + 暂存）。 */
export function collectChanges(root, { base = null } = {}) {
  const range = base ? `${base}...HEAD` : 'HEAD';
  const numstat = spawnSync('git', ['diff', '--numstat', '--find-renames', range], {
    cwd: root,
    encoding: 'utf8',
  });
  const diff = spawnSync('git', ['diff', '--no-color', '--unified=0', range], {
    cwd: root,
    encoding: 'utf8',
  });
  const files = [];
  if (numstat.status === 0) {
    for (const line of numstat.stdout.split(/\r?\n/).filter(Boolean)) {
      const [added, removed, ...rest] = line.split('\t');
      const path = rest.join('\t').replace(/^.* => /, '').replace(/[{}]/g, '');
      files.push({
        path: path.trim(),
        additions: added === '-' ? 0 : Number(added) || 0,
        deletions: removed === '-' ? 0 : Number(removed) || 0,
      });
    }
  }
  // 未跟踪文件不属于 diff，但仍是本次改动的一部分。
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
      files.push({ path: line.trim(), additions: 0, deletions: 0, untracked: true });
    }
  }
  return { files, diffText: diff.status === 0 ? diff.stdout : '' };
}

function autoTrigger(profile, { flow, reviewRequired, userSpecified }) {
  if (flow === 'full' || flow === 'light-feature' || flow === 'unknown') return 'mandatory';
  if (userSpecified) return 'user';
  if (reviewRequired) return 'required';
  const highRisk = profile.ranked.find((r) =>
    ['security', 'data', 'concurrency', 'deps', 'acceptance'].includes(r.direction) && r.score >= 2);
  if (highRisk) return 'auto';
  if (profile.stats.changedLines > 200 || profile.stats.codeFiles > 10) return 'auto';
  return 'skipped';
}

/**
 * 生成完整审查计划：触发判定 + 风险画像 + 方向选择。
 * 用户显式方向优先；数量上限受 --agents 覆盖，硬上限 4。
 */
export function buildReviewPlan({
  flow = 'unknown',
  reviewRequired = false,
  files = [],
  diffText = '',
  focus = [],
  agents = null,
  noSubagents = false,
  focusOnly = false,
} = {}) {
  const profile = profileChanges({ files, diffText, focus, agents, noSubagents, focusOnly });
  const userSpecified = [...new Set(focus)].filter((d) => DIRECTIONS.includes(d)).length > 0;
  // 用户显式要求派代理，等同于要求审查，不能因为风险低而判成跳过。
  const explicitAgents = agents !== null && agents !== undefined
    && Number.isFinite(Number(agents)) && Number(agents) > 0;
  const trigger = autoTrigger(profile, {
    flow,
    reviewRequired,
    userSpecified: userSpecified || explicitAgents,
  });
  const base = {
    flow,
    trigger,
    reviewRequired: Boolean(reviewRequired),
    ...profile,
  };
  // 跳过时不派代理；画像与排除理由保留，避免“跳过”等于“没看过”。
  if (trigger === 'skipped') {
    return {
      ...base,
      maxAgents: 0,
      capSource: 'skipped',
      selected: [],
      assignments: [],
      excluded: [
        ...profile.excluded,
        ...profile.selected.map((r) => ({
          ...r,
          reason: '未触发自动审查；主阶段基线检查覆盖，需要时用 --focus 或 review: required',
        })),
      ],
    };
  }
  return base;
}

export function renderPlan(plan) {
  const lines = [];
  const flowLabel = {
    full: '完整任务',
    'light-feature': '轻量功能',
    'light-bug': '轻量修复',
    unknown: '未识别',
  }[plan.flow] || plan.flow;
  const triggerLabel = {
    mandatory: '必审',
    required: 'debug 标记 review: required',
    auto: '自动风险信号',
    user: '用户指定',
    skipped: '跳过（已留痕）',
  }[plan.trigger] || plan.trigger;
  lines.push(`流程：${flowLabel}`);
  lines.push(`触发：${triggerLabel}`);
  const capLabel = {
    default: '按风险等级',
    none: '用户禁用',
    user: '用户指定',
    'user-focus': '用户方向数',
    skipped: '未触发审查',
  }[plan.capSource] || plan.capSource;
  lines.push(`风险等级：${plan.level}（代理上限 ${plan.maxAgents}，${capLabel}）`);
  lines.push(`改动：${plan.stats.files} 个文件 / ${plan.stats.changedLines} 行；测试 ${plan.stats.testFiles} 个，未跟踪 ${plan.stats.untracked} 个`);
  if (plan.selected.length) {
    lines.push(`选中方向：${plan.selected.map((r) => `${DIRECTION_LABELS[r.direction]}(${r.score})`).join('、')}`);
  } else {
    lines.push('选中方向：无（主阶段基线检查）');
  }
  if (plan.excluded.length) {
    lines.push(`排除方向：${plan.excluded.map((r) => `${DIRECTION_LABELS[r.direction]}（${r.reason}）`).join('；')}`);
  }
  if (plan.assignments.length) {
    lines.push(`代理编排：${plan.assignments.map((a) => `${a.agent}:${a.directions.map((d) => DIRECTION_LABELS[d]).join('+')}`).join('；')}`);
  }
  return lines.join('\n');
}
