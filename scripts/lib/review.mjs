import {
  existsSync, lstatSync, readFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPathInside, readText } from './common.mjs';

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
const TEST_PATTERN = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/i;
// 测试文件里的正则文本会命中自身规则，扫描内容时跳过，避免自我放大。
// 插件自身的规则定义文件由调用方通过 selfPath 传入，不能硬编码路径：
// 普通项目里同名的 scripts/lib/review.mjs 是用户代码，仍应正常扫描。
const CONTENT_SKIP_PATTERN = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/i;
// 未跟踪文件没有 diff，读取有限内容补足风险信号；超过该大小按路径计分。
const UNTRACKED_LIMIT = 64 * 1024;

function isCodeFile(path) {
  return !DOC_PATTERN.test(path) && !GENERATED_PATTERN.test(path) && !TEST_PATTERN.test(path);
}

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

/** 本模块自身在项目内的相对路径；只在 devflow 仓库开发时非 null。 */
export function selfSourcePath(root) {
  try {
    const rel = relative(root, fileURLToPath(import.meta.url));
    if (!rel || isAbsolute(rel) || rel.startsWith('..')) return null;
    return rel.replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function scanDiff(text, map, selfPath = null) {
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  let skipContent = false;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      current = line.slice(4).replace(/^b\//, '');
      skipContent = CONTENT_SKIP_PATTERN.test(current)
        || Boolean(selfPath && current === selfPath);
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('@@') || line.startsWith('diff ')) continue;
    if (skipContent || !/^[+-]/.test(line)) continue;
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
  selfPath = null,
} = {}) {
  const map = new Map();
  const normalizedFiles = files.map((file) => ({
    path: String(file.path || '').replace(/\\/g, '/'),
    additions: Number(file.additions) || 0,
    deletions: Number(file.deletions) || 0,
    untracked: Boolean(file.untracked),
  }));

  for (const file of normalizedFiles) scanPath(file, map);
  scanDiff(diffText, map, selfPath);

  const changedLines = normalizedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const codeFiles = normalizedFiles.filter((f) => isCodeFile(f.path));
  const codeChangedLines = codeFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const testFiles = normalizedFiles.filter((f) => TEST_PATTERN.test(f.path));

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
  else if (maxScore >= 1 || codeFiles.length >= 4 || codeChangedLines >= 30) level = 'medium';

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
    selected.sort((a, b) => focusList.indexOf(a.direction) - focusList.indexOf(b.direction));
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
  }

  // 代理上限只限制实际派单，不裁剪选中方向：用户要求与风险信号必须可追溯。
  const dispatched = selected.slice(0, cap);
  const dispatchedDirections = new Set(dispatched.map((r) => r.direction));
  const deferred = selected
    .filter((r) => !dispatchedDirections.has(r.direction))
    .map((r) => ({ ...r, reason: capReason(cap, capSource) }));
  const assignments = buildAssignments(dispatched);

  // 未入选方向显式记为排除，避免“没派代理”被误读成“已覆盖”。
  const selectedDirections = new Set(selected.map((r) => r.direction));
  const excludedDirections = new Set(excluded.map((r) => r.direction));
  for (const r of ranked) {
    if (selectedDirections.has(r.direction) || excludedDirections.has(r.direction)) continue;
    excluded.push({ ...r, reason: '未入选本次审查方向' });
  }

  return {
    level,
    maxAgents: cap,
    capSource,
    selected,
    excluded,
    deferred,
    assignments,
    ranked,
    stats: {
      files: normalizedFiles.length,
      codeFiles: codeFiles.length,
      testFiles: testFiles.length,
      changedLines,
      codeChangedLines,
      untracked: normalizedFiles.filter((f) => f.untracked).length,
    },
  };
}

/** 轻量流程升级的硬触发方向：命中任一即需升级完整流程。 */
export const ESCALATION_DIRECTIONS = {
  security: '权限/认证/支付/安全边界',
  data: '数据结构或迁移',
  concurrency: '并发与状态',
  deps: '依赖变更',
  acceptance: '公共接口或契约',
};

const SOFT_LINE_LIMIT = 200;
const SOFT_FILE_LIMIT = 10;
const SOFT_SUBPROJECT_LIMIT = 2;

/**
 * 把风险画像复用到轻量流程的升级入口（debug / req --light）。
 * 只覆盖 diff 可推导的硬触发；根因范围、假设收敛等人工判断仍需模型补充。
 */
export function evaluateEscalation(profile, {
  statsAvailable = true, files = [], subprojects = {},
} = {}) {
  const reasons = [];
  const signals = [];
  for (const r of profile.ranked) {
    const label = ESCALATION_DIRECTIONS[r.direction];
    if (!label || r.score < 2) continue;
    signals.push(r);
    reasons.push(`${label}（${r.reasons.join('、')}）`);
  }
  if (profile.stats.codeChangedLines > SOFT_LINE_LIMIT) {
    reasons.push(`非测试/文档改动 ${profile.stats.codeChangedLines} 行，超过 ${SOFT_LINE_LIMIT}`);
  }
  if (profile.stats.codeFiles > SOFT_FILE_LIMIT) {
    reasons.push(`非测试/文档文件 ${profile.stats.codeFiles} 个，超过 ${SOFT_FILE_LIMIT}`);
  }
  const touched = new Set();
  for (const file of files) {
    const path = String(file.path || '').replace(/\\/g, '/');
    for (const [name, sub] of Object.entries(subprojects || {})) {
      const base = String(sub?.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (base && (path === base || path.startsWith(`${base}/`))) touched.add(name);
    }
  }
  if (touched.size > SOFT_SUBPROJECT_LIMIT) {
    reasons.push(`改动涉及 ${touched.size} 个子项目（${[...touched].join('、')}），超过 ${SOFT_SUBPROJECT_LIMIT}`);
  }
  return {
    escalate: reasons.length > 0,
    confident: statsAvailable,
    reasons,
    signals: signals.map((r) => ({ direction: r.direction, score: r.score, reasons: r.reasons })),
    stats: profile.stats,
    subprojects: [...touched],
    warnings: statsAvailable ? [] : ['无法统计 git 改动，升级判断不完整；不要据此跳过人工核对。'],
  };
}

function capReason(cap, capSource) {  if (cap === 0) {
    if (capSource === 'none') return '用户要求不派子代理，主上下文按此方向自查';
    if (capSource === 'user') return '用户指定 0 个代理，主上下文按此方向自查';
    return '未分配子代理，主上下文基线检查覆盖';
  }
  return `超出代理上限 ${cap}，主上下文补查`;
}

function buildAssignments(dispatched) {
  const directions = new Set(dispatched.map((r) => r.direction));
  const assignments = AGENT_GROUPS
    .map((group) => ({
      agent: group.id,
      directions: group.directions.filter((d) => directions.has(d)),
    }))
    .filter((group) => group.directions.length > 0);
  // 未落入预设分组的方向单独成组，避免静默丢弃。
  const grouped = new Set(assignments.flatMap((g) => g.directions));
  for (const r of dispatched) {
    if (!grouped.has(r.direction)) assignments.push({ agent: `X${r.direction}`, directions: [r.direction] });
  }
  return assignments;
}

export function readReviewMarker(root, slug) {
  const file = join(root, 'docs', 'devflow', slug, 'debug.md');
  if (!existsSync(file)) return null;
  try {
    const head = readText(file).split(/\r?\n/).slice(0, 10).join('\n');
    // 只支持显式要求审查；`review: skipped` 不能作为绕过 triage 的开关。
    const m = /^review:\s*['"]?required['"]?\s*$/m.exec(head);
    return m ? 'required' : null;
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

/** 大仓库的 diff 可能超过默认 1MB；超出时 spawnSync 会以 ENOBUFS 失败，这里放宽并显式提示。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(root, args) {
  // core.quotePath=false 避免非 ASCII 路径被转义成 "\346\226\207" 形式。
  return spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/** numstat 的 rename 路径可能写成 `dir/{old => new}/file` 或 `old => new`。 */
function renameTarget(raw) {
  const brace = /^(.*?)\{(.*?) => (.*?)\}(.*)$/.exec(raw);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/').replace(/^\//, '');
  const arrow = /^(.*) => (.*)$/.exec(raw);
  return arrow ? arrow[2].trim() : raw.trim();
}

/**
 * 从 git 收集工作区或分支差异。
 * base 用三点比较（合并基线后的分支改动）；since 用两点（该提交之后的所有改动，含工作区）；
 * 都不传时比较 HEAD（工作区 + 暂存）。
 */
export function collectChanges(root, { base = null, since = null } = {}) {
  if (base && since) throw new Error('base 与 since 不能同时使用');
  const range = since || (base ? `${base}...HEAD` : 'HEAD');
  const numstat = git(root, ['diff', '--numstat', '--find-renames', '--no-ext-diff', '--no-textconv', range]);
  const diff = git(root, ['diff', '--no-color', '--unified=0', '--no-ext-diff', '--no-textconv', range]);
  const warnings = [];
  const files = [];
  if (numstat.status === 0) {
    for (const line of numstat.stdout.split(/\r?\n/).filter(Boolean)) {
      const [added, removed, ...rest] = line.split('\t');
      const path = renameTarget(rest.join('\t'));
      if (!path) continue;
      files.push({
        path,
        additions: added === '-' ? 0 : Number(added) || 0,
        deletions: removed === '-' ? 0 : Number(removed) || 0,
      });
    }
  } else if (numstat.error?.code === 'ENOBUFS') {
    warnings.push('git diff 输出超过缓冲上限，改动统计可能不完整');
  } else {
    warnings.push('无法统计 git diff 的文件改动，改动规模可能不完整');
  }
  // 未跟踪文件不属于 diff，但仍是本次改动的一部分；行数按实际内容统计。
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  const untrackedDiffs = [];
  if (untracked.status === 0) {
    for (const line of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
      const path = line.trim();
      const content = readUntrackedText(root, path);
      const additions = content ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0;
      files.push({ path, additions, deletions: 0, untracked: true });
      // 未跟踪文件没有 diff，读取有限内容补足密钥、迁移等信号。
      if (content) {
        untrackedDiffs.push(`diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n`
          + content.split(/\r?\n/).map((text) => `+${text}`).join('\n'));
      }
    }
  } else if (untracked.error?.code === 'ENOBUFS') {
    warnings.push('未跟踪文件列表超过缓冲上限，新增文件可能未完整计入');
  } else {
    warnings.push('无法读取未跟踪文件列表，新增文件可能未计入');
  }
  const parts = [];
  if (diff.status === 0) parts.push(diff.stdout);
  else if (diff.error?.code === 'ENOBUFS') {
    warnings.push('git diff 内容超过缓冲上限，内容风险信号可能缺失');
  } else {
    warnings.push('无法读取 git diff 内容，内容风险信号可能缺失');
  }
  parts.push(...untrackedDiffs);
  return {
    files,
    diffText: parts.join('\n'),
    warnings,
    statsAvailable: numstat.status === 0 && diff.status === 0,
  };
}

function readUntrackedText(root, rel) {
  try {
    const abs = join(root, rel);
    if (!isPathInside(root, abs)) return '';
    const stat = lstatSync(abs);
    // 不跟随符号链接，也不读取超大或二进制文件。
    if (!stat.isFile() || stat.size > UNTRACKED_LIMIT) return '';
    const buffer = readFileSync(abs);
    if (buffer.includes(0)) return '';
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function autoTrigger(profile, {
  flow, reviewRequired, userSpecified, statsAvailable = true,
}) {
  if (flow === 'full' || flow === 'light-feature' || flow === 'unknown') return 'mandatory';
  if (userSpecified) return 'user';
  if (reviewRequired) return 'required';
  // 无法统计改动时不能据空 diff 判跳过，否则会静默漏审。
  if (!statsAvailable) return 'auto';
  const highRisk = profile.ranked.find((r) =>
    ['security', 'data', 'concurrency', 'deps', 'acceptance'].includes(r.direction) && r.score >= 2);
  if (highRisk) return 'auto';
  if (profile.stats.codeChangedLines > 200 || profile.stats.codeFiles > 10) return 'auto';
  return 'skipped';
}

/** 触发审查但未命中方向时，补一个可执行的基线方向，避免“必审但无方向”。 */
function ensureBaseline(profile) {
  if (profile.selected.length) return profile;
  const candidate = profile.ranked.find((r) => r.score >= 1)
    || { direction: 'correctness', score: 0, reasons: ['基线检查'], files: [], bonus: 0 };
  const baseline = {
    ...candidate,
    reasons: [...new Set([...(candidate.reasons || []), '触发审查但未命中具体方向，按基线方向审查'])],
  };
  const cap = profile.maxAgents;
  return {
    ...profile,
    selected: [baseline],
    excluded: profile.excluded.filter((r) => r.direction !== baseline.direction),
    assignments: cap > 0 ? buildAssignments([baseline]) : [],
    deferred: cap > 0 ? [] : [{ ...baseline, reason: capReason(cap, profile.capSource) }],
  };
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
  statsAvailable = true,
  selfPath = null,
} = {}) {
  let profile = profileChanges({
    files, diffText, focus, agents, noSubagents, focusOnly, selfPath,
  });
  const userSpecified = [...new Set(focus)].filter((d) => DIRECTIONS.includes(d)).length > 0;
  // 用户显式要求派代理，等同于要求审查，不能因为风险低而判成跳过。
  const explicitAgents = agents !== null && agents !== undefined
    && Number.isFinite(Number(agents)) && Number(agents) > 0;
  const trigger = autoTrigger(profile, {
    flow,
    reviewRequired,
    userSpecified: userSpecified || explicitAgents,
    statsAvailable,
  });
  // 标记、用户或风险信号触发时必须给出可执行方向；mandatory 的低风险改动仍可由基线覆盖。
  if (['auto', 'user', 'required'].includes(trigger) && !focusOnly) {
    profile = ensureBaseline(profile);
  }
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
      deferred: [],
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
  if (plan.scope?.mode === 'incremental') {
    lines.push(`范围：增量复审（自 ${plan.scope.since} 起）`);
  }
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
  if (plan.assignments.length) {
    lines.push(`代理编排：${plan.assignments.map((a) => `${a.agent}:${a.directions.map((d) => DIRECTION_LABELS[d]).join('+')}`).join('；')}`);
  } else if (plan.selected.length) {
    lines.push('代理编排：未派子代理（主上下文按选中方向自查）');
  }
  if (plan.deferred?.length) {
    lines.push(`主上下文补查：${plan.deferred.map((r) => `${DIRECTION_LABELS[r.direction]}（${r.reason}）`).join('；')}`);
  }
  if (plan.excluded.length) {
    lines.push(`排除方向：${plan.excluded.map((r) => `${DIRECTION_LABELS[r.direction]}（${r.reason}）`).join('；')}`);
  }
  return lines.join('\n');
}
