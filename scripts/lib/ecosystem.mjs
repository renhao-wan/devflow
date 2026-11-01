#!/usr/bin/env node
// 工具生态索引：项目声明可路由的相似工具，检测结果与配置分离存放。
// 检测只读技能目录与 settings.json 的 enabledPlugins，不读取技能内容、不执行外部命令。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ensureDir, readText, writeAtomic, parseYaml, isValidStageName,
} from './common.mjs';

export const ECOSYSTEM_FILE = '.claude/hub/ecosystem.yaml';
export const STATE_FILE = '.claude/.ecosystem-state.json';

/** 阶段对应的执行技法入口；用于把 invoke 模板里的 {capability} 替换成实际技能。 */
export const STAGE_CAPABILITY = {
  plan: 'brainstorming',
  implement: 'test-driven-development',
  test: 'verification-before-completion',
  review: 'requesting-code-review',
  debug: 'systematic-debugging',
};

/**
 * 已知工具目录。detectSkills 对应技能目录名，detectPlugins 对应 settings.enabledPlugins 的键。
 * technique 只接管执行技法，workflow 会改变整个流程，因此 auto 模式只自动委派 technique。
 */
export const CATALOG = {
  superpowers: {
    label: 'superpowers',
    kind: 'technique',
    stages: ['plan', 'implement', 'test', 'review', 'debug'],
    invoke: '/superpowers:{capability}',
    detectSkills: [
      'brainstorming', 'writing-plans', 'test-driven-development',
      'systematic-debugging', 'requesting-code-review', 'receiving-code-review',
      'verification-before-completion', 'using-git-worktrees',
    ],
    detectPlugins: ['superpowers'],
    note: '执行技法（brainstorming、计划、TDD、排障、评审）；不管理阶段与产物。',
  },
  bmad: {
    label: 'BMAD-METHOD',
    kind: 'workflow',
    stages: ['req', 'plan', 'implement'],
    invoke: '/bmad',
    detectSkills: ['bmad'],
    detectPlugins: ['bmad'],
    note: '完整敏捷方法论；接管流程时需确认是否放弃 devflow 门禁与产物。',
  },
  'spec-kit': {
    label: 'GitHub Spec Kit',
    kind: 'workflow',
    stages: ['req', 'plan', 'implement'],
    invoke: '/speckit',
    detectSkills: ['speckit', 'specify'],
    detectPlugins: ['spec-kit'],
    note: '规格 → 计划 → 任务 → 实现；与 devflow 阶段高度重叠。',
  },
  openspec: {
    label: 'OpenSpec',
    kind: 'workflow',
    stages: ['req', 'plan', 'review'],
    invoke: '/openspec',
    detectSkills: ['openspec'],
    detectPlugins: ['openspec'],
    note: '变更提案与归档；适合需要长期追溯的规格变更。',
  },
  'cc-spec-driven': {
    label: 'cc-spec-driven',
    kind: 'workflow',
    stages: ['req', 'plan', 'implement', 'review'],
    invoke: '/dd-status',
    detectSkills: ['cc-spec-driven', 'spec-driven'],
    detectPlugins: ['cc-spec-driven'],
    note: '强状态机；与 devflow 的 fail-open 取舍不同。',
  },
  'spec-workflow': {
    label: 'Claude Code Spec Workflow',
    kind: 'workflow',
    stages: ['req', 'plan', 'implement', 'test', 'review'],
    invoke: '/spec-create',
    detectSkills: ['spec-create', 'spec-execute', 'spec-status'],
    detectPlugins: ['spec-workflow'],
    note: '一条命令跑完规格流程；适合快速结构化开发。',
  },
  ucai: {
    label: 'ucai',
    kind: 'workflow',
    stages: ['req', 'plan', 'implement', 'review'],
    invoke: '/ucai',
    detectSkills: ['ucai'],
    detectPlugins: ['ucai'],
    note: '原生插件式结构化工作流；与 devflow 阶段重叠。',
  },
};

const PREFERRED_KIND = {
  req: 'workflow',
  plan: 'technique',
  implement: 'technique',
  test: 'technique',
  review: 'technique',
  debug: 'technique',
};

function toArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null) return [];
  return [String(value)].filter(Boolean);
}

function catalogTool(id) {
  const item = CATALOG[id];
  if (!item) return null;
  return {
    label: item.label,
    enabled: true,
    kind: item.kind,
    stages: [...item.stages],
    invoke: item.invoke,
    detectSkills: [...item.detectSkills],
    detectPlugins: [...item.detectPlugins],
    note: item.note,
  };
}

export function defaultConfig() {
  const tools = {};
  for (const id of Object.keys(CATALOG)) {
    tools[id] = catalogTool(id);
  }
  return {
    version: 1,
    routing: {
      mode: 'ask',
      forceDevflowStages: [],
      detectMaxAgeDays: 14,
    },
    tools,
  };
}

function normalizeTool(id, parsed, base) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const b = base || {};
  const kind = p.kind ?? b.kind ?? 'workflow';
  return {
    label: String(p.label ?? b.label ?? id),
    enabled: p.enabled !== false,
    // 未知 kind 一律按 workflow 处理：宁可多问一次，也不自动接管流程。
    kind: kind === 'technique' ? 'technique' : 'workflow',
    stages: toArray(p.stages ?? b.stages),
    invoke: String(p.invoke ?? b.invoke ?? ''),
    detectSkills: toArray(p.detectSkills ?? b.detectSkills),
    detectPlugins: toArray(p.detectPlugins ?? b.detectPlugins),
    note: String(p.note ?? b.note ?? ''),
  };
}

export function normalizeConfig(parsed) {
  const base = defaultConfig();
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const r = p.routing && typeof p.routing === 'object' ? p.routing : {};
  const mode = ['off', 'ask', 'auto'].includes(r.mode) ? r.mode : 'ask';
  const maxAge = Number(r.detectMaxAgeDays);
  const tools = {};
  if (p.tools && typeof p.tools === 'object' && !Array.isArray(p.tools)) {
    for (const [id, tool] of Object.entries(p.tools)) {
      tools[id] = normalizeTool(id, tool, CATALOG[id] || null);
    }
  } else {
    Object.assign(tools, base.tools);
  }
  return {
    version: Number(p.version) || 1,
    routing: {
      mode,
      forceDevflowStages: toArray(r.forceDevflowStages),
      detectMaxAgeDays: Number.isInteger(maxAge) && maxAge > 0 ? maxAge : 14,
    },
    tools,
  };
}

function yamlScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value == null) return 'null';
  // 只使用双引号包裹；内部双引号替换为单引号、换行替换为空格，避免极简 YAML 解析器无法还原。
  const text = String(value).replace(/\r?\n/g, ' ').replace(/"/g, "'");
  return `"${text}"`;
}

export function renderConfig(config) {
  const lines = [
    '# devflow 工具生态索引。可自由修改；检测结果写入 .claude/.ecosystem-state.json。',
    '# routing.mode: off（不路由）| ask（默认，先询问）| auto（自动委派 technique 工具）',
    '# tools.<id>.kind: technique（只接管执行技法）| workflow（接管整个流程，auto 下也只建议）',
    'version: 1',
    '',
    'routing:',
    `  mode: ${yamlScalar(config.routing.mode)}`,
    `  forceDevflowStages: [${config.routing.forceDevflowStages.map(yamlScalar).join(', ')}]`,
    `  detectMaxAgeDays: ${yamlScalar(config.routing.detectMaxAgeDays)}`,
    '',
    'tools:',
  ];
  for (const [id, tool] of Object.entries(config.tools)) {
    lines.push(`  ${id}:`);
    lines.push(`    label: ${yamlScalar(tool.label)}`);
    lines.push(`    enabled: ${tool.enabled !== false}`);
    lines.push(`    kind: ${yamlScalar(tool.kind)}`);
    lines.push(`    stages: [${tool.stages.map(yamlScalar).join(', ')}]`);
    lines.push(`    invoke: ${yamlScalar(tool.invoke)}`);
    lines.push(`    detectSkills: [${tool.detectSkills.map(yamlScalar).join(', ')}]`);
    lines.push(`    detectPlugins: [${tool.detectPlugins.map(yamlScalar).join(', ')}]`);
    lines.push(`    note: ${yamlScalar(tool.note)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function ecosystemPath(root) {
  return join(root, ...ECOSYSTEM_FILE.split('/'));
}

export function statePath(root) {
  return join(root, ...STATE_FILE.split('/'));
}

export function loadEcosystem(root) {
  const file = ecosystemPath(root);
  if (!existsSync(file)) {
    return { file, exists: false, config: defaultConfig(), raw: null, error: null };
  }
  try {
    const raw = parseYaml(readText(file));
    return { file, exists: true, config: normalizeConfig(raw), raw, error: null };
  } catch (err) {
    return { file, exists: true, config: defaultConfig(), raw: null, error: err.message };
  }
}

export function createDefaultConfig(root) {
  const file = ecosystemPath(root);
  ensureDir(join(root, '.claude', 'hub'));
  writeAtomic(file, renderConfig(defaultConfig()));
  return file;
}

export function loadState(root) {
  const file = statePath(root);
  if (!existsSync(file)) {
    return {
      file,
      exists: false,
      state: { schemaVersion: 1, detectedAt: null, tools: {} },
      error: null,
    };
  }
  try {
    const state = JSON.parse(readText(file));
    return { file, exists: true, state, error: null };
  } catch (err) {
    return {
      file,
      exists: true,
      state: { schemaVersion: 1, detectedAt: null, tools: {} },
      error: err.message,
    };
  }
}

function readEnabledPlugins(files) {
  const keys = new Set();
  for (const file of files) {
    try {
      const data = JSON.parse(readText(file));
      for (const [key, value] of Object.entries(data.enabledPlugins || {})) {
        if (value !== false) keys.add(key);
      }
    } catch { /* 缺失或损坏的 settings 不阻断检测 */ }
  }
  return [...keys];
}

function hasSkill(dirs, name) {
  return dirs.some((dir) => existsSync(join(dir, name, 'SKILL.md'))
    || existsSync(join(dir, `${name}.md`)));
}

const DETECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** 检测名必须是单段目录/插件名，避免 `../` 把存在性探测引到项目外。 */
function isValidDetectName(name) {
  const text = String(name);
  return DETECT_NAME_RE.test(text) && !text.includes('..');
}

/** 只检查存在性：技能目录、settings.enabledPlugins。不读技能内容，不记录绝对路径。 */
export function detectTools(root, config, options = {}) {
  const home = options.home || homedir();
  const skillDirs = [
    join(root, '.claude', 'skills'),
    join(home, '.claude', 'skills'),
  ];
  const settingsFiles = [
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
    join(home, '.claude', 'settings.json'),
  ];
  const enabledPlugins = readEnabledPlugins(settingsFiles);
  const result = {};
  for (const [id, tool] of Object.entries(config.tools || {})) {
    // 已禁用的工具不参与检测，避免状态文件、doctor 与 SessionStart 把它列为可用。
    if (tool.enabled === false) {
      result[id] = { available: false, signals: [] };
      continue;
    }
    const signals = [];
    for (const name of tool.detectSkills || []) {
      if (!isValidDetectName(name)) continue;
      if (hasSkill(skillDirs, name)) signals.push(`skill:${name}`);
    }
    for (const name of tool.detectPlugins || []) {
      if (!isValidDetectName(name)) continue;
      if (enabledPlugins.some((key) => key === name || key.startsWith(`${name}@`))) {
        signals.push(`plugin:${name}`);
      }
    }
    result[id] = { available: signals.length > 0, signals };
  }
  return result;
}

export function writeDetectedState(root, config, options = {}) {
  const state = {
    schemaVersion: 1,
    detectedAt: new Date().toISOString(),
    tools: detectTools(root, config, options),
  };
  ensureDir(join(root, '.claude'));
  writeAtomic(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function isStale(state, maxAgeDays = 14) {
  const at = Date.parse(state?.detectedAt || '');
  if (Number.isNaN(at)) return true;
  const age = Date.now() - at;
  return age > Number(maxAgeDays) * 24 * 60 * 60 * 1000;
}

function resolveInvoke(invoke, stage) {
  const capability = STAGE_CAPABILITY[stage] || stage;
  return String(invoke || '')
    .replaceAll('{capability}', capability)
    .replaceAll('{stage}', stage);
}

function toolInfo(id, tool, state, stage) {
  const recorded = state?.tools?.[id] || {};
  return {
    id,
    label: tool.label || id,
    kind: tool.kind,
    available: recorded.available === true,
    signals: Array.isArray(recorded.signals) ? recorded.signals : [],
    invoke: resolveInvoke(tool.invoke, stage),
    stages: [...tool.stages],
    note: tool.note,
  };
}

function constraints(kind) {
  return {
    keepStageGates: true,
    keepArtifacts: true,
    autoAllowed: kind === 'technique',
  };
}

function useDevflow(base, reason) {
  return {
    ...base,
    decision: 'use-devflow',
    reason,
    tool: null,
    alternatives: [],
    constraints: constraints(null),
  };
}

function routeError(base, reason) {
  return {
    ...base,
    decision: 'error',
    reason,
    tool: null,
    alternatives: [],
    constraints: constraints(null),
  };
}

/**
 * 路由只决定“谁来执行当前阶段的技法”，不改变阶段顺序、门禁与产物路径。
 * 优先级：强制 devflow > 指定工具 > mode=off > 强制阶段 > 候选匹配。
 */
export function decideRoute({
  config, state, stage, forceDevflow = false, toolId = null,
}) {
  if (!stage) throw new Error('缺少 --stage');
  const mode = config.routing.mode;
  const base = { stage, mode };

  if (forceDevflow || toolId === 'devflow') {
    return useDevflow(base, '已强制使用 devflow');
  }

  if (toolId) {
    const tool = config.tools[toolId];
    if (!tool) return routeError(base, `未知工具：${toolId}`);
    if (tool.enabled === false) return routeError(base, `工具已禁用：${toolId}`);
    if (!tool.stages.includes(stage)) {
      return routeError(base, `工具 ${toolId} 未声明支持 ${stage} 阶段`);
    }
    const info = toolInfo(toolId, tool, state, stage);
    const warnings = info.available ? [] : [
      `未检测到 ${toolId}；如未安装，调用会失败。运行 devflow route --detect 更新检测结果。`,
    ];
    return {
      ...base,
      decision: 'delegate',
      reason: `用户指定使用 ${info.label}`,
      tool: info,
      alternatives: [],
      constraints: constraints(info.kind),
      warnings,
    };
  }

  if (mode === 'off') return useDevflow(base, 'routing.mode=off');
  if (config.routing.forceDevflowStages.includes(stage)) {
    return useDevflow(base, `阶段 ${stage} 被配置为强制使用 devflow`);
  }

  const candidates = [];
  let order = 0;
  for (const [id, tool] of Object.entries(config.tools)) {
    order += 1;
    if (tool.enabled === false || !tool.stages.includes(stage)) continue;
    const info = toolInfo(id, tool, state, stage);
    if (!info.available) continue;
    candidates.push({ ...info, _order: order });
  }
  if (!candidates.length) {
    return useDevflow(base, '没有检测到适用于该阶段的可用工具');
  }

  const preferred = PREFERRED_KIND[stage] || 'technique';
  candidates.sort((a, b) => {
    const ak = a.kind === preferred ? 0 : 1;
    const bk = b.kind === preferred ? 0 : 1;
    if (ak !== bk) return ak - bk;
    return a._order - b._order;
  });
  const { _order, ...top } = candidates[0];
  const alternatives = candidates.slice(1).map(({ _order: ignored, ...item }) => item);

  if (mode === 'auto' && top.kind === 'technique') {
    return {
      ...base,
      decision: 'delegate',
      reason: `auto 模式：${top.label} 更适合 ${stage} 阶段的执行技法`,
      tool: top,
      alternatives,
      constraints: constraints(top.kind),
    };
  }

  const reason = mode === 'auto'
    ? `${top.label} 是 workflow 类工具；auto 不自动接管整个流程，先询问`
    : `${top.label} 可能更适合 ${stage} 阶段`;
  return {
    ...base,
    decision: 'suggest',
    reason,
    tool: top,
    alternatives,
    constraints: constraints(top.kind),
  };
}

/** 校验用户手写的原始配置；normalizeConfig 会把非法值静默回退，所以这里检查 raw。 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') return { errors, warnings };
  if (raw.version != null && Number(raw.version) !== 1) {
    warnings.push(`ecosystem.yaml version 应为 1，当前为 ${raw.version}`);
  }
  const routing = raw.routing;
  if (routing != null) {
    if (typeof routing !== 'object') {
      errors.push('routing 应为映射');
    } else {
      if (routing.mode != null && !['off', 'ask', 'auto'].includes(routing.mode)) {
        errors.push(`routing.mode 应为 off|ask|auto，当前为 ${routing.mode}`);
      }
      if (routing.forceDevflowStages != null && !Array.isArray(routing.forceDevflowStages)) {
        errors.push('routing.forceDevflowStages 应为列表');
      } else if (Array.isArray(routing.forceDevflowStages)) {
        const bad = routing.forceDevflowStages.filter((s) => !isValidStageName(s));
        if (bad.length) errors.push(`routing.forceDevflowStages 含非法阶段名：${bad.join('、')}`);
      }
      if (routing.detectMaxAgeDays != null
        && (!Number.isInteger(Number(routing.detectMaxAgeDays)) || Number(routing.detectMaxAgeDays) < 1)) {
        errors.push('routing.detectMaxAgeDays 应为正整数');
      }
    }
  }
  if (raw.tools != null) {
    if (typeof raw.tools !== 'object' || Array.isArray(raw.tools)) {
      errors.push('tools 应为映射');
    } else {
      for (const [id, tool] of Object.entries(raw.tools)) {
        if (!tool || typeof tool !== 'object') {
          errors.push(`tools.${id} 应为映射`);
          continue;
        }
        if (tool.kind != null && !['technique', 'workflow'].includes(tool.kind)) {
          errors.push(`tools.${id}.kind 应为 technique|workflow，当前为 ${tool.kind}`);
        }
        if (tool.enabled != null && typeof tool.enabled !== 'boolean') {
          errors.push(`tools.${id}.enabled 应为布尔值`);
        }
        if (tool.stages != null && !Array.isArray(tool.stages)) {
          errors.push(`tools.${id}.stages 应为列表`);
        } else if (Array.isArray(tool.stages)) {
          const bad = tool.stages.filter((s) => !isValidStageName(s));
          if (bad.length) errors.push(`tools.${id}.stages 含非法阶段名：${bad.join('、')}`);
        }
        for (const key of ['detectSkills', 'detectPlugins']) {
          if (tool[key] != null && !Array.isArray(tool[key])) {
            errors.push(`tools.${id}.${key} 应为列表`);
          } else if (Array.isArray(tool[key])) {
            const bad = tool[key].filter((name) => !isValidDetectName(name));
            if (bad.length) {
              errors.push(`tools.${id}.${key} 含非法名称：${bad.join('、')}（只允许单段字母、数字、点、下划线或连字符）`);
            }
          }
        }
        if (tool.invoke != null && typeof tool.invoke !== 'string') {
          errors.push(`tools.${id}.invoke 应为字符串`);
        }
      }
    }
  }
  if (routing?.mode === 'auto') {
    const tools = raw.tools && typeof raw.tools === 'object' ? Object.values(raw.tools) : [];
    const hasTechnique = tools.some((t) => t && t.kind === 'technique' && t.enabled !== false);
    if (!hasTechnique) {
      warnings.push('routing.mode=auto 但没有启用的 technique 工具；只会建议，不会自动委派');
    }
  }
  return { errors, warnings };
}

export function listAvailableTools(config, state) {
  return Object.entries(config.tools || {})
    .filter(([id, tool]) => tool.enabled !== false && state?.tools?.[id]?.available === true)
    .map(([id, tool]) => ({
      id,
      label: tool.label || id,
      kind: tool.kind,
      stages: [...tool.stages],
      note: tool.note,
    }));
}

export function summarizeState(state, config = null) {
  if (!state) return { detectedAt: null, available: [] };
  const tools = config?.tools || null;
  return {
    detectedAt: state.detectedAt || null,
    available: Object.entries(state.tools || {})
      // 展示层与检测层保持一致：配置已禁用的工具即使残留旧检测结果也不再算可用。
      .filter(([id, value]) => value?.available === true
        && (!tools || tools[id]?.enabled !== false))
      .map(([id]) => id),
  };
}
