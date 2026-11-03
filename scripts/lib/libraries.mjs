import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {
  readMeta, findPluginRoot, isPluginCache, isPathInside, canonicalPath,
  posix, walk, relPosix, isGeneratedArtifact,
} from './common.mjs';

export const LIBRARY_KINDS = ['team', 'personal', 'upstream'];

// 三个库共用插件模板布局：templates/stages/**、templates/shared/**。
const TEMPLATE_ROOTS = [
  { src: 'stages', hub: 'stages' },
  { src: 'shared', hub: '_shared' },
];

export function defaultPersonalRoot() {
  return join(homedir(), '.claude', 'devflow');
}

function envPath(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolvePersonalRoot(meta, { personalLibrary, env } = {}) {
  const raw = personalLibrary || envPath(env, 'DEVFLOW_PERSONAL_LIBRARY')
    || meta?.personalLibraryPath || defaultPersonalRoot();
  return resolve(raw);
}

function resolveTeamRoot(root, templates, meta, { teamLibrary, env } = {}) {
  const team = templates?.team && typeof templates.team === 'object' ? templates.team : {};
  const configured = typeof team.path === 'string' && team.path.trim() ? team.path.trim() : null;
  // 团队库默认不启用：必须由 hub.yaml 配置，或命令行显式指定。
  // 环境变量与 .devflow.json 只提供本机路径，不单独构成启用意图。
  const enabled = team.enabled === true || Boolean(configured) || Boolean(teamLibrary);
  if (!enabled || (team.enabled === false && !teamLibrary)) return null;

  // CLI/env/.devflow.json 是本机路径，按当前工作目录解析；hub.yaml 的 path 相对项目根。
  let teamRoot = null;
  if (teamLibrary) teamRoot = resolve(teamLibrary);
  else {
    const envTeam = envPath(env, 'DEVFLOW_TEAM_LIBRARY');
    if (envTeam) teamRoot = resolve(envTeam);
    else if (meta?.teamLibraryPath) teamRoot = resolve(meta.teamLibraryPath);
    else if (configured) teamRoot = isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
  }
  if (!teamRoot) {
    const clone = team.repo ? `先执行 git clone ${team.repo} <path>，再` : '';
    throw new Error(`${clone}在 hub.yaml 写 templates.team.path，或在 .devflow.json 写 teamLibraryPath。`);
  }
  if (!existsSync(teamRoot)) {
    const hint = team.repo
      ? `先执行 git clone ${team.repo} ${posix(teamRoot)}。`
      : '确认路径正确，或在 .devflow.json 写 teamLibraryPath 覆盖。';
    throw new Error(`团队模板库路径不存在：${posix(teamRoot)}。${hint}`);
  }
  return teamRoot;
}

/**
 * 解析启用的模板库，按 order 排列（先出现者优先）。
 * 没有 templates 块的旧项目只使用上游库，保持既有行为。
 */
export function resolveLibraries(root, hubConfig = {}, {
  pluginRoot = null, personalLibrary = null, teamLibrary = null, env = process.env, meta = null,
} = {}) {
  const { order, personal, team, upstream } = describeLibraries(root, hubConfig, {
    pluginRoot, personalLibrary, teamLibrary, env, meta,
  });
  // 只有团队库真正参与来源合并时才因配置错误中止；
  // 配置了但未写进 order 的团队库不应阻断只使用个人/上游的同步。
  if (team.error && order.includes('team')) throw new Error(team.error);

  const libraries = [];
  for (const kind of order) {
    if (kind === 'team' && team.root) {
      libraries.push({ kind, root: team.root, templateRoot: join(team.root, 'templates') });
    } else if (kind === 'personal') {
      libraries.push({ kind, root: personal.root, templateRoot: join(personal.root, 'templates') });
    } else if (kind === 'upstream') {
      libraries.push({ kind, root: upstream.root, templateRoot: join(upstream.root, 'templates') });
    }
  }
  return libraries;
}

/**
 * 只做解析与状态描述，不因团队库路径缺失而抛错，供 doctor 展示与诊断。
 * 启用规则必须与 resolveLibraries 保持一致。
 */
export function describeLibraries(root, hubConfig = {}, {
  pluginRoot = null, personalLibrary = null, teamLibrary = null, env = process.env, meta = null,
} = {}) {
  const templates = hubConfig?.templates && typeof hubConfig.templates === 'object'
    ? hubConfig.templates
    : null;
  const fallback = templates ? ['personal', 'upstream'] : ['upstream'];
  const requested = Array.isArray(templates?.order) && templates.order.length
    ? templates.order
    : fallback;
  const personalDisabled = templates?.personal?.enabled === false;
  const order = [...new Set(requested.filter((kind) => LIBRARY_KINDS.includes(kind)))]
    .filter((kind) => kind !== 'personal' || !personalDisabled);
  // 上游是兜底来源；配置漏写时自动补在最后，避免没有基础模板。
  if (!order.includes('upstream')) order.push('upstream');

  const metaData = meta || readMeta(root) || {};
  const personalRoot = resolvePersonalRoot(metaData, { personalLibrary, env });

  let team;
  const teamConfigured = Boolean(templates?.team?.path)
    || templates?.team?.enabled === true
    || Boolean(teamLibrary);
  try {
    const teamRoot = resolveTeamRoot(root, templates, metaData, { teamLibrary, env });
    team = {
      enabled: Boolean(teamRoot),
      configured: teamConfigured,
      root: teamRoot,
      exists: Boolean(teamRoot),
      repo: typeof templates?.team?.repo === 'string' ? templates.team.repo : null,
      error: null,
    };
  } catch (err) {
    team = {
      enabled: teamConfigured,
      configured: teamConfigured,
      root: null,
      exists: false,
      repo: typeof templates?.team?.repo === 'string' ? templates.team.repo : null,
      error: err.message,
    };
  }

  return {
    order,
    requested,
    personal: { root: personalRoot, exists: existsSync(personalRoot) },
    team,
    upstream: { root: pluginRoot || findPluginRoot(root) },
  };
}

/**
 * 按库优先级收集模板文件，同名文件先到先得（团队 > 个人 > 上游）。
 * 返回项的 hubRel 是 `.claude/hub/` 内的相对路径，可直接用于同步账本。
 */
/**
 * 解析单个回灌目标库。与 resolveLibraries 不同，它不受 order 限制：
 * 即使 hub.yaml 没启用个人/团队库，也可以显式回灌到该库（团队库仍需已配置路径）。
 */
export function resolveLibraryRoot(root, kind, {
  hubConfig = {}, pluginRoot = null, personalLibrary = null, teamLibrary = null,
  env = process.env, meta = null,
} = {}) {
  const metaData = meta || readMeta(root) || {};
  const templates = hubConfig?.templates && typeof hubConfig.templates === 'object'
    ? hubConfig.templates
    : null;
  if (kind === 'personal') {
    return { kind, root: resolvePersonalRoot(metaData, { personalLibrary, env }) };
  }
  if (kind === 'team') {
    const teamRoot = resolveTeamRoot(root, templates, metaData, { teamLibrary, env });
    if (!teamRoot) {
      throw new Error('团队模板库未启用：在 hub.yaml 的 templates.team 配置 enabled: true 与 path，或传 --team-library。');
    }
    return { kind, root: teamRoot };
  }
  if (kind === 'upstream') {
    return { kind, root: pluginRoot || findPluginRoot(root) };
  }
  throw new Error(`未知模板库：${kind}`);
}

export function collectTemplateFiles(libraries) {
  const seen = new Set();
  const out = [];
  for (const library of libraries) {
    for (const def of TEMPLATE_ROOTS) {
      const base = join(library.templateRoot, def.src);
      if (!existsSync(base)) continue;
      for (const abs of walk(base)) {
        const rel = relPosix(base, abs);
        if (isGeneratedArtifact(rel) || rel.split('/').pop() === '_feedback-log.md') continue;
        const hubRel = `${def.hub}/${rel}`;
        if (seen.has(hubRel)) continue;
        seen.add(hubRel);
        out.push({
          hubRel,
          destRel: `.claude/hub/${hubRel}`,
          src: abs,
          source: library.kind,
        });
      }
    }
  }
  return out.sort((a, b) => a.hubRel.localeCompare(b.hubRel));
}

/** 回灌写入前校验：库不能与项目互相嵌套，个人/团队库不能落在插件安装缓存。 */
export function assertLibraryRoot(projectRoot, libRoot, kind = 'personal') {
  const project = canonicalPath(projectRoot);
  const library = canonicalPath(libRoot);
  if (library === project) {
    throw new Error(`模板库不能是当前项目根：${posix(libRoot)}`);
  }
  if (isPathInside(projectRoot, libRoot)) {
    throw new Error(`模板库不能位于当前项目内：${posix(libRoot)}`);
  }
  if (isPathInside(libRoot, projectRoot)) {
    throw new Error(`当前项目不能位于模板库内：${posix(libRoot)}`);
  }
  if (kind !== 'upstream' && isPluginCache(libRoot)) {
    throw new Error(`模板库不能位于插件安装缓存：${posix(libRoot)}；插件升级会清空该目录。`);
  }
  return true;
}
