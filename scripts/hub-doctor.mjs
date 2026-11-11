#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, delimiter, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  pluginInfo, findPluginRoot, satisfies, readText, contentHash, normalizeEol, log,
  posix, isMain, projectRoot, argValue, hasFlag, parseYaml, canonicalPath, walk,
  isPluginCache, isValidPluginRoot, samePath, isValidStageName, isPathInside, isDraft,
  warnUnknownArgs,
} from './lib/common.mjs';
import { LOADERS, loaderSource } from './lib/loaders.mjs';
import { COMMANDS } from './lib/cli-commands.mjs';
import { templateIssues } from './lib/template-compat.mjs';
import {
  OVERVIEW_FILE, AUTO_START, AUTO_END, scanFacts, readHubFacts, factsFingerprint, readFactsFingerprint,
} from './lib/overview.mjs';
import {
  ECOSYSTEM_FILE, STATE_FILE, isStale, loadEcosystem, loadState,
  summarizeState, validateConfig,
} from './lib/ecosystem.mjs';
import { LIBRARY_KINDS, describeLibraries } from './lib/libraries.mjs';
import { planStacks } from './lib/stacks.mjs';
import { resolveStages } from './lib/stages.mjs';
import { ledgerStackFileAbs, readSources, readLock, stackPaths } from './lib/stack-ledger.mjs';
import { listTree } from './lib/stack-install.mjs';
import {
  ensureRepo, refreshRef, resolveCommit, stackCacheRoot,
} from './lib/stack-fetch.mjs';

const KNOWN_TOOLS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'node', 'npx',
  'mvn', 'gradle', 'go', 'cargo', 'dotnet', 'make',
  'pytest', 'python', 'python3',
]);

function commandTools(command) {
  return String(command)
    .split(/&&|\|\||;/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => seg.split(/\s+/)[0])
    .filter((tool) => tool && !/^cd$/i.test(tool) && !/[\\/]/.test(tool))
    .map((tool) => tool.replace(/^["']|["']$/g, ''));
}

/** cd 目标与本地脚本（./gradlew、gradlew.bat 等）必须真实存在。 */
function localCommandIssues(root, label, command) {
  const issues = [];
  let dir = root;
  for (const seg of String(command).split(/&&|\|\||;/).map((s) => s.trim()).filter(Boolean)) {
    const cd = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(seg);
    if (cd) {
      const target = cd[1] ?? cd[2] ?? cd[3];
      const abs = resolve(dir, target);
      if (!existsSync(abs)) issues.push(`${label} 的 cd 目录不存在：${posix(abs)}（${command}）`);
      else dir = abs;
      continue;
    }
    const tool = seg.split(/\s+/)[0].replace(/^["']|["']$/g, '');
    if (/^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|.*\.(bat|cmd|sh|ps1)$)/i.test(tool)) {
      if (!existsSync(resolve(dir, tool))) issues.push(`${label} 的本地命令不存在：${tool}`);
    }
  }
  return issues;
}

function toolExists(tool) {
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, tool + ext))) return true;
    }
  }
  return false;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readText(file)); } catch { return fallback; }
}

const PLUGIN_STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

// 建议按“先修工作区、再修配置、最后处理生成物与日常状态”的顺序排列。
const HINT_RULES = [
  (hint) => /^\/devflow:init\b/.test(hint),
  (hint) => /^(修改|删除|把|在|填写|安装)/.test(hint),
  (hint) => /\/devflow:sync\b/.test(hint),
  (hint) => /scripts\/devflow-gen\.mjs/.test(hint),
  (hint) => /\/devflow:onboard\b/.test(hint),
  (hint) => /\/devflow:test\b/.test(hint),
  (hint) => /devflow route --detect/.test(hint),
  (hint) => /\/devflow:upstream\b/.test(hint),
  (hint) => /claude plugin list/.test(hint),
];

export function hintPriority(hint) {
  const index = HINT_RULES.findIndex((rule) => rule(hint));
  return index === -1 ? HINT_RULES.length : index;
}

function shortenReason(text, max = 60) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 按优先级输出建议；init 系列合并成一行，并在合并时保留触发原因。 */
export function renderHints(hints) {
  const groups = new Map();
  for (const [hint, reasons] of hints) {
    const key = /^\/devflow:init\b/.test(hint) ? '/devflow:init' : hint;
    if (!groups.has(key)) groups.set(key, { hints: [], reasons: [] });
    const group = groups.get(key);
    if (!group.hints.includes(hint)) group.hints.push(hint);
    group.reasons.push(...reasons);
  }
  return [...groups.values()]
    .map((group) => ({ group, priority: Math.min(...group.hints.map(hintPriority)) }))
    .sort((a, b) => a.priority - b.priority)
    .map(({ group }) => {
      const label = group.hints.join('；或 ');
      const reasons = [...new Set(group.reasons.map((reason) => shortenReason(reason)))];
      // 只有一个原因时保持原有的一行建议，避免把提醒正文重复一遍。
      if (reasons.length <= 1) return `建议：${label}`;
      const shown = reasons.slice(0, 3);
      const suffix = reasons.length > shown.length ? ` 等 ${reasons.length} 项` : '';
      return `建议：${label}（${shown.join('；')}${suffix}）`;
    });
}

/** 版本权威只认 plugin.json、package.json 与 marketplace 中 name 匹配的 plugins[].version。 */
function checkPluginVersions(add, root, info) {
  const pkg = readJson(join(root, 'package.json'));
  const market = readJson(join(root, '.claude-plugin', 'marketplace.json'));
  const entries = Array.isArray(market?.plugins) ? market.plugins : [];
  const marketEntry = entries.find((entry) => entry?.name === info.name);
  // marketplace 顶层的 metadata.version 是市场自身版本，不参与插件版本校验。
  const sources = [
    ['plugin.json', info.version],
    ['package.json', pkg?.version],
    ['marketplace plugins[]', marketEntry?.version],
  ];
  const missing = sources.filter(([, version]) => typeof version !== 'string' || !version);
  if (missing.length) {
    add('error', `版本来源缺失：${missing.map(([label]) => label).join('、')}`);
    return;
  }
  const detail = sources.map(([label, version]) => `${label} ${version}`).join('，');
  if (new Set(sources.map(([, version]) => version)).size === 1) {
    add('ok', `插件版本一致：${detail}`);
  } else {
    add('error', `插件版本不一致：${detail}`);
  }
}

function checkPluginHooks(add, pluginRoot) {
  try {
    const pluginHooks = join(pluginRoot, 'hooks', 'hooks.json');
    if (existsSync(pluginHooks)) {
      const h = readJson(pluginHooks, {});
      const hookMap = h.hooks && typeof h.hooks === 'object' ? h.hooks : {};
      const count = Object.values(hookMap).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
      add('ok', `插件 hooks 已注册 ${count} 组`);

      const requiredEvents = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'];
      for (const event of requiredEvents) {
        if (!Array.isArray(hookMap[event]) || !hookMap[event].length) {
          add('warn', `hooks.json 缺少事件 ${event}`, '确认插件安装完整：claude plugin list');
        }
      }

      const commands = [];
      for (const groups of Object.values(hookMap)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          for (const hook of group?.hooks || []) {
            if (typeof hook?.command === 'string') commands.push(hook.command);
          }
        }
      }

      for (const script of ['guard-dangerous.mjs', 'guard-generated.mjs', 'track-changes.mjs', 'prompt-reminder.mjs', 'subagent-note.mjs', 'check-tests.mjs', 'load-hub.mjs']) {
        const p = join(pluginRoot, 'hooks', 'scripts', script);
        if (!existsSync(p)) {
          add('error', `缺少 hooks 脚本 ${script}`);
        } else if (!commands.some((command) => command.includes(script))) {
          add('warn', `hooks.json 未注册 ${script}`, '确认插件安装完整：claude plugin list');
        }
      }
    } else {
      add('warn', '插件未提供 hooks.json', '确认插件安装完整：claude plugin list');
    }
  } catch {
    add('warn', '无法检查 hooks', '确认插件安装完整：claude plugin list');
  }
}

/** 插件源码仓库自身的一致性；不读取任何项目工作区配置。 */
function checkPluginRepo(add, root, info) {
  checkPluginVersions(add, root, info);
  checkPluginHooks(add, root);

  const missingScripts = [...new Set(Object.values(COMMANDS).map(([file]) => file))]
    .filter((file) => !existsSync(join(root, 'scripts', file)));
  if (missingScripts.length) {
    add('error', `CLI 命令脚本缺失：${missingScripts.map((file) => `scripts/${file}`).join('、')}`);
  } else {
    add('ok', `CLI 的 ${Object.keys(COMMANDS).length} 个子命令脚本齐全`);
  }

  const missingStages = PLUGIN_STAGES
    .filter((stage) => !existsSync(join(root, 'templates', 'stages', stage, 'SKILL.md')));
  if (missingStages.length) {
    add('error', `阶段模板缺失：${missingStages.map((stage) => `templates/stages/${stage}/SKILL.md`).join('、')}`);
  } else {
    add('ok', `六个阶段模板齐全（${PLUGIN_STAGES.join('、')}）`);
  }

  const skillsDir = join(root, 'skills');
  if (!existsSync(skillsDir)) {
    add('error', '缺少 skills/ 目录');
    return;
  }
  const bad = [];
  let total = 0;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    total += 1;
    const file = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(file)) {
      bad.push(`${entry.name}（缺少 SKILL.md）`);
      continue;
    }
    const text = readText(file);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const nameLine = frontmatter && /^name:\s*(\S+)\s*$/m.exec(frontmatter[1]);
    if (!frontmatter) bad.push(`${entry.name}（缺少 frontmatter）`);
    else if (!nameLine) bad.push(`${entry.name}（frontmatter 缺少 name）`);
    else if (nameLine[1] !== entry.name) bad.push(`${entry.name}（name 为 ${nameLine[1]}）`);
  }
  if (bad.length) {
    add('error', `技能 frontmatter 与目录不一致：${bad.join('、')}`);
  } else {
    add('ok', `${total} 个技能的 frontmatter name 与目录一致`);
  }
}

/** 账本里的目标路径必须落在 skillsRoot 内，且真实路径不能借符号链接跳出项目。 */
function safeManifestTarget(root, rel) {
  if (!rel || String(rel).startsWith('/') || String(rel).includes('..')) return null;
  const target = join(root, ...String(rel).split('/'));
  if (!isPathInside(join(root, '.claude', 'skills'), target)) return null;
  let anchor = target;
  while (!existsSync(anchor)) {
    const parent = dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
  }
  const rootReal = canonicalPath(root);
  const anchorReal = canonicalPath(anchor);
  if (anchorReal !== rootReal && !anchorReal.startsWith(`${rootReal}/`)) return null;
  return target;
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, ['--root', '--json', '--mode', '--check-remote']);
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  // 设计第 15 节：只有显式 --check-remote 才联网，默认体检不访问网络。
  const checkRemote = hasFlag(argv, '--check-remote');
  const requestedMode = argValue(argv, '--mode', 'auto');
  if (!['auto', 'plugin', 'project'].includes(requestedMode)) {
    throw new Error(`--mode 只支持 auto、plugin 或 project，当前为：${requestedMode}`);
  }
  const rows = [];
  const hints = new Map();
  const addHint = (hint, reason) => {
    if (!hints.has(hint)) hints.set(hint, []);
    if (reason) hints.get(hint).push(reason);
  };
  const add = (status, message, hint) => {
    rows.push({ status, message });
    if (hint) addHint(hint, message);
  };

  let isPluginRepo = false;
  try {
    isPluginRepo = isValidPluginRoot(root) && pluginInfo(root).name === 'devflow';
  } catch {
    isPluginRepo = false;
  }
  const hasHub = existsSync(join(root, '.claude', 'hub', 'hub.yaml'));
  // hub 工作区优先：插件仓库同时初始化了 devflow 时，按项目检查更有意义。
  const mode = requestedMode === 'auto'
    ? (hasHub || !isPluginRepo ? 'project' : 'plugin')
    : requestedMode;
  // auto 在双身份目录里只会走项目检查；显式提示另一条路径仍然可用。
  if (requestedMode === 'auto' && hasHub && isPluginRepo) {
    add('info', '检测到插件仓库同时是 devflow 项目；插件自检请用 --mode plugin');
  }

  const finish = () => {
    if (json) {
      console.log(JSON.stringify({ root: posix(root), mode, rows }, null, 2));
    } else {
      for (const r of rows) log(r.status, r.message);
      const errors = rows.filter((r) => r.status === 'error').length;
      const warns = rows.filter((r) => r.status === 'warn').length;
      const infos = rows.filter((r) => r.status === 'info').length;
      console.log(`\n${errors} 个错误，${warns} 个提醒，${infos} 条提示。`);
      if (warns) for (const line of renderHints(hints)) console.log(line);
    }
    if (rows.some((r) => r.status === 'error')) process.exitCode = 1;
    return rows;
  };

  if (mode === 'plugin') {
    if (!isPluginRepo) {
      add('error', `当前目录不是 devflow 插件源码仓库（需要 .claude-plugin/plugin.json 且 name 为 devflow）：${posix(root)}`);
      return finish();
    }
    add('info', '插件源码仓库模式：跳过项目工作区配置检查');
    let info;
    try {
      info = pluginInfo(root);
      add('ok', `插件 ${info.name}@${info.version}（${posix(root)}）`);
    } catch (err) {
      add('error', err.message);
      return finish();
    }
    checkPluginRepo(add, root, info);
    return finish();
  }

  const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
  let config = null;
  if (!existsSync(hubFile)) {
    add('error', `缺少 ${posix(hubFile)}，请先运行 /devflow:init`);
  } else {
    try {
      config = parseYaml(readText(hubFile));
      add('ok', 'hub.yaml 语法有效');
    } catch (err) {
      add('error', `hub.yaml 解析失败：${err.message}`);
    }
  }

  if (config) {
    if (Number(config.version) !== 1) add('warn', `hub.yaml version 应为 1，当前为 ${config.version}`, '修改 .claude/hub/hub.yaml 的 version 字段为 1');
    if (Array.isArray(config.stages)) {
      const bad = config.stages.filter((s) => !isValidStageName(s));
      if (bad.length) add('error', `hub.yaml stages 含非法阶段名：${bad.join('、')}`);
      if (new Set(config.stages).size !== config.stages.length) add('warn', 'hub.yaml stages 有重复项', '删除 .claude/hub/hub.yaml 的 stages 列表中的重复阶段');
    }
    const blocked = config.upstream?.blocklist;
    if (blocked != null && !Array.isArray(blocked)) add('warn', 'hub.yaml upstream.blocklist 应为列表', '把 .claude/hub/hub.yaml 的 upstream.blocklist 改为 YAML 列表');

    const stagePlan = resolveStages(config, root);
    if (stagePlan.error) {
      add('error', stagePlan.error, '把 .claude/hub/hub.yaml 的 stages 改成 YAML 列表；写 [] 表示不启用任何阶段');
    }
    const stages = stagePlan.stages;
    const stackPlan = planStacks(root, config, stages);
    for (const issue of stackPlan.issues) {
      // 草稿统一在下方统计，避免同一文件被报告两次。
      if (issue.severity === 'warn' && /草稿/.test(issue.message)) continue;
      const hint = issue.severity === 'error'
        ? '运行 /devflow:sync 补齐技术栈模板，或修正 .claude/hub/hub.yaml 的 stack 声明'
        : '在 .claude/hub/stacks/<stack>/ 添加 _shared.md 或 <stage>.md';
      add(issue.severity, issue.message, hint);
    }
    if (stackPlan.rows.length && !stackPlan.issues.some((i) => i.severity === 'error')) {
      const names = [...new Set(stackPlan.rows.map((row) => row.stack))];
      add('ok', `技术栈映射有效：${stackPlan.rows.length} 个子项目 → ${names.join('、')}`);
    }

    const drafts = [];
    const stageEntryDrafts = [];
    for (const name of ['_shared', 'stages', 'stacks', 'overrides']) {
      const dir = join(root, '.claude', 'hub', name);
      for (const abs of walk(dir, '.md')) {
        if (!isDraft(readText(abs))) continue;
        const rel = posix(relative(root, abs));
        // 阶段入口本身不是规则文件，标记草稿会让整个阶段读取到占位内容。
        if (/^\.claude\/hub\/stages\/[^/]+\/SKILL\.md$/.test(rel)) stageEntryDrafts.push(rel);
        else drafts.push(rel);
      }
    }
    if (stageEntryDrafts.length) {
      add('warn', `阶段入口 SKILL.md 不支持草稿标记：${stageEntryDrafts.join('、')}`,
        '删除首行草稿标记后运行 node scripts/devflow-gen.mjs');
    }
    if (drafts.length) {
      // 草稿是可选占位：保留 INFO，不再计入提醒与建议。
      add('info', `${drafts.length} 个规则草稿待填写：${drafts.join('、')}`);
    } else {
      add('ok', '没有待填写的规则草稿');
    }
  }

  const stackState = stackPaths(root);
  const staleHubSources = join(root, '.claude', '.hub-sources.json');
  const staleHubBases = join(root, '.claude', '.hub-bases', 'stacks');
  try {
    const sources = readSources(root);
    const lock = readLock(root);
    const entries = Object.values(sources.packs);
    if (!entries.length && !Object.keys(lock.packs).length) {
      add('ok', '没有受管的技术栈包');
    }
    // 陈旧记录检查与具体记录无关：整个账本只读取、解析一次。
    let hubSourceKeys = [];
    if (existsSync(staleHubSources)) {
      try {
        const data = JSON.parse(readText(staleHubSources));
        hubSourceKeys = Object.keys(data?.files || {});
      } catch { /* 由现有 hub-sources 检查处理 */ }
    }
    for (const record of entries) {
      const dir = stackState.stackDir(record.installedAs);
      // 目录缺失时无法比对哈希，但 lock 与陈旧记录检查仍必须执行。
      if (!existsSync(dir)) {
        add('error', `受管栈目录缺失：.claude/hub/stacks/${record.installedAs}`, '运行 devflow stack restore');
      } else {
        const missing = [];
        const modified = [];
        const fileEntries = Object.entries(record.files || {});
        for (const [rel, hashes] of fileEntries) {
          // 手改账本可能给出越界路径；统一走账本校验，失败即中止 doctor。
          const abs = ledgerStackFileAbs(root, record.installedAs, rel);
          // local === null 表示上次更新时本地已删除；这是账本事实，不能只看文件是否存在。
          if (hashes.local === null || !existsSync(abs)) {
            missing.push(rel);
            continue;
          }
          // 手改只报告，不阻断；缺失才给恢复建议。
          // base 偏离 local 同样说明本地已偏离受管基线（restore modified / update 合并结果）。
          if (contentHash(readText(abs)) !== hashes.local
            || (typeof hashes.base === 'string' && hashes.local !== hashes.base)) modified.push(rel);
        }
        // 实际目录中不属于账本的文件：可能是有价值的本地文件，只提醒不删除。
        const prefix = `.claude/hub/stacks/${record.installedAs}/`;
        const managed = new Set(fileEntries
          .filter(([rel]) => rel.startsWith(prefix))
          .map(([rel]) => rel.slice(prefix.length).toLowerCase()));
        const extra = listTree(dir)
          .filter((file) => !managed.has(file.rel.toLowerCase()))
          .map((file) => file.rel)
          .sort();
        if (missing.length) {
          add('warn', `受管栈 ${record.installedAs} 缺失 ${missing.length} 个文件：${missing.join('、')}`, '运行 devflow stack restore');
        }
        if (modified.length) {
          add('info', `受管栈 ${record.installedAs} 有 ${modified.length} 个文件被手改（保留，不阻断）`);
        }
        if (extra.length) {
          // 文件名不可信：去掉控制字符并限制数量，避免日志注入；不回显账本 key。
          const shown = extra.slice(0, 5).map((name) => String(name).replace(/[\0-\x1f\x7f]/g, '?'));
          const suffix = extra.length > shown.length ? ` 等 ${extra.length} 个` : '';
          add('warn', `受管栈 ${record.installedAs} 有 ${extra.length} 个额外文件（不由 pack 管理）：${shown.join('、')}${suffix}`, '确认后删除这些文件，或运行 devflow stack remove');
        }
        if (!missing.length && !modified.length && !extra.length) {
          add('ok', `受管栈 ${record.installedAs}@${record.version} 完整`);
        }
      }
      // 设计第 3 节：本地来源不写 lock，只有 git 来源缺失条目才值得提醒。
      if (record.source === 'git' && !lock.packs[record.installedAs]) {
        add('warn', `受管栈 ${record.installedAs} 未写入 stack-lock.yaml`, '运行 devflow stack lock');
      }
      const prefix = `.claude/hub/stacks/${record.installedAs}/`;
      if (hubSourceKeys.some((rel) => rel.startsWith(prefix))) {
        add('warn', `受管栈 ${record.installedAs} 仍有陈旧的 .hub-sources.json 记录`, '运行 devflow sync 或手工删除该记录');
      }
      if (existsSync(join(staleHubBases, record.installedAs))) {
        add('warn', `受管栈 ${record.installedAs} 仍有陈旧的 .hub-bases 快照`, '删除该目录；pack 使用 .stack-bases');
      }
      if (checkRemote && record.source === 'git' && record.repo) {
        try {
          const info = ensureRepo({
            url: record.repo,
            cacheRoot: stackCacheRoot(),
            allowFile: process.env.DEVFLOW_STACK_ALLOW_LOCAL_REPO === '1',
          });
          const ref = record.ref || 'main';
          refreshRef({ repoGit: info.repoGit, ref });
          const latest = resolveCommit({ repoGit: info.repoGit, ref });
          if (record.commit && latest !== record.commit) {
            add(
              'warn',
              `受管栈 ${record.installedAs} 落后于 ${ref}（本地 ${record.commit.slice(0, 8)}，远程 ${latest.slice(0, 8)}）`,
              '运行 devflow stack update',
            );
          }
        } catch (err) {
          // 网络或证书问题不应让 doctor 失败；只说明本次无法检查。
          add('warn', `无法检查 ${record.installedAs} 的远程状态：${err.message}`);
        }
      }
    }
    // 设计第 15 节：lock 与本地账本也要比对，不能只在 lock 缺失时提示；
    // 即使账本为空也要检查，否则锁里的孤立条目永远不会被发现。
    for (const [name, entry] of Object.entries(lock.packs)) {
      const record = sources.packs[name];
      if (!record) {
        add('warn', `stack-lock.yaml 记录了未安装的包 ${name}`, '运行 devflow stack restore，或手工删除该条目');
        continue;
      }
      if (record.packId !== entry.packId || record.repo !== entry.repo) {
        add('warn', `受管栈 ${name} 的来源与 stack-lock.yaml 不一致`, '运行 devflow stack lock 重建');
      } else if (record.commit && entry.commit && record.commit !== entry.commit) {
        add('warn', `受管栈 ${name} 的 commit 与 stack-lock.yaml 不一致`, '运行 devflow stack lock 重建');
      }
    }
  } catch (err) {
    // 账本或 lock 损坏必须让 doctor 失败，不能降级成“没有受管栈”。
    add('error', err.message, '修复或删除 .claude/.stack-sources.json / stack-lock.yaml 后重试');
  }

  const eco = loadEcosystem(root);
  if (!eco.exists) {
    add('warn', `缺少 ${ECOSYSTEM_FILE}，运行 /devflow:init 可生成；不影响 devflow 阶段流程`, '/devflow:init');
  } else if (eco.error) {
    add('warn', `${ECOSYSTEM_FILE} 解析失败，路由会回退默认配置：${eco.error}`, `/devflow:init 重新生成 ${ECOSYSTEM_FILE}`);
  } else {
    add('ok', `${ECOSYSTEM_FILE} 语法有效（mode=${eco.config.routing.mode}）`);
    const { errors, warnings } = validateConfig(eco.raw);
    for (const err of errors) add('error', `${ECOSYSTEM_FILE}：${err}`);
    for (const warning of warnings) add('warn', `${ECOSYSTEM_FILE}：${warning}`);
  }
  const ecoState = loadState(root);
  if (!ecoState.exists) {
    add('warn', `缺少 ${STATE_FILE}，运行 devflow route --detect 生成检测结果`, 'devflow route --detect');
  } else if (ecoState.error) {
    add('warn', `${STATE_FILE} 损坏：${ecoState.error}，运行 devflow route --detect 重建`, 'devflow route --detect');
  } else if (isStale(ecoState.state, eco.config.routing.detectMaxAgeDays)) {
    add('warn', `工具检测结果已过期（${ecoState.state.detectedAt || '无时间'}），运行 devflow route --detect 更新`, 'devflow route --detect');
  } else {
    const available = summarizeState(ecoState.state, eco.config).available;
    add('ok', available.length ? `工具检测：${available.join('、')}` : '工具检测：未发现已知工具');
  }

  let pluginRoot = null;
  let info = null;
  try {
    pluginRoot = findPluginRoot(root);
    info = pluginInfo(pluginRoot);
    add('ok', `插件 ${info.name}@${info.version}（${posix(pluginRoot)}）`);
  } catch (err) {
    add('error', err.message);
  }

  const metaFile = join(root, '.devflow.json');
  let meta = null;
  if (!existsSync(metaFile)) {
    add('warn', '缺少 .devflow.json，运行 /devflow:init 可重建', '/devflow:init');
  } else {
    try {
      meta = JSON.parse(readText(metaFile));
    } catch (err) {
      add('error', `.devflow.json 损坏：${err.message}，运行 /devflow:init 可重建`);
    }
  }
  if (meta?.pluginVersion && info?.version && meta.pluginVersion !== info.version) {
    add('warn', `.devflow.json 记录的插件版本 ${meta.pluginVersion} 与当前 ${info.version} 不一致，建议运行 /devflow:sync 或重跑 /devflow:init`, '/devflow:sync');
  }
  if (meta?.pluginRoot && pluginRoot && !samePath(meta.pluginRoot, pluginRoot)) {
    if (isPluginCache(meta.pluginRoot)) {
      add('ok', '插件路径已更新（升级或缓存变化）；阶段模板可用 /devflow:sync 同步');
    } else {
      add('warn', `记录的插件路径与当前不一致：${posix(meta.pluginRoot)} → ${posix(pluginRoot)}，可重跑 /devflow:init 刷新记录`, '/devflow:init');
    }
  } else if (pluginRoot && isPluginCache(pluginRoot)) {
    add('ok', '运行于安装缓存；回灌需 --plugin-root 或 pluginSourceRoot');
  }
  if (meta?.pluginSourceRoot) {
    if (isValidPluginRoot(meta.pluginSourceRoot)) {
      add('ok', `回灌源码仓库：${posix(meta.pluginSourceRoot)}`);
    } else {
      add('warn', `回灌源码仓库不存在：${posix(meta.pluginSourceRoot)}，请重跑 /devflow:init --source-root <路径>`, '/devflow:init --source-root <路径>');
    }
  }

  if (config && pluginRoot) {
    const version = pluginInfo(pluginRoot).version;
    try {
      if (satisfies(version, config.requiresPlugin || '*')) {
        add('ok', `版本满足 requiresPlugin ${config.requiresPlugin || '*'}`);
      } else {
        add('error', `插件版本 ${version} 不满足 requiresPlugin ${config.requiresPlugin}`);
      }
    } catch (err) {
      add('error', err.message);
    }
  }

  if (config && pluginRoot) {
    let libs = null;
    try {
      libs = describeLibraries(root, config, { pluginRoot, meta });
    } catch (err) {
      add('error', `模板库解析失败：${err.message}`);
    }
    if (libs) {
      const invalid = libs.requested.filter((kind) => !LIBRARY_KINDS.includes(kind));
      if (invalid.length) {
        add('warn', `templates.order 含未知库：${invalid.join('、')}`,
          'templates.order 只支持 team|personal|upstream');
      }
      if (libs.requested.length && new Set(libs.requested).size !== libs.requested.length) {
        add('warn', 'templates.order 有重复项', '删除 .claude/hub/hub.yaml 中 templates.order 的重复库');
      }
      if (!libs.requested.includes('upstream')) {
        add('warn', 'templates.order 未显式包含 upstream', '保留 upstream 作为兜底来源；缺失时运行时会自动补到最后');
      }
      if (libs.requested.includes('team') && !libs.team.enabled) {
        add('warn', 'templates.order 含 team，但团队库未启用',
          '在 hub.yaml 的 templates.team 配置 enabled: true 与 path，或从 order 移除 team');
      }
      if (libs.team.configured && !libs.order.includes('team')) {
        add('warn', '团队库已配置，但 templates.order 未包含 team，当前不会使用',
          '把 team 加入 templates.order，或删除 templates.team 配置');
      }

      add('ok', `上游库：${posix(libs.upstream.root)}`);
      if (libs.order.includes('personal')) {
        add('ok', `个人库：${posix(libs.personal.root)}`);
        if (!libs.personal.exists) {
          add('info', `个人库目录尚未创建：${posix(libs.personal.root)}`);
        }
      } else {
        add('ok', '个人库未启用（templates.order 不含 personal）');
      }

      if (libs.team.error) {
        add('error', `团队库不可用：${libs.team.error}`);
      } else if (libs.team.enabled) {
        add('ok', `团队库：${posix(libs.team.root)}${libs.team.repo ? `（${libs.team.repo}）` : ''}`);
        // 团队库回灌与 --pr 都要求 git；sync 仅读取模板则不强制。
        const top = spawnSync('git', ['-C', libs.team.root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
        if (top.status !== 0) {
          add('warn', `团队库不是 git 仓库：${posix(libs.team.root)}`,
            '回灌与 --pr 需要 git 仓库；在该目录 git init，或改为 clone 的仓库');
        } else if (!samePath(top.stdout.trim(), libs.team.root)) {
          add('warn', `团队库不是 git 仓库顶层：${posix(libs.team.root)} 位于 ${posix(top.stdout.trim())} 内`,
            `请把 templates.team.path 指到仓库根 ${posix(top.stdout.trim())}`);
        }
      } else {
        add('ok', '团队库未启用（可选；在 hub.yaml 配置 templates.team 启用）');
      }

      const enabled = libs.order.filter((kind) =>
        kind !== 'team' || (libs.team.enabled && !libs.team.error));
      add('ok', `模板来源优先级：${enabled.join(' > ')}`);
    }
  }

  if (info) {
    const loaderFiles = new Set(Object.keys(LOADERS));
    const templateDirs = [
      join(root, '.claude', 'hub', 'stages'),
      join(root, '.claude', 'hub', '_shared'),
      join(root, '.claude', 'hub', 'stacks'),
    ];
    const issues = [];
    let scanned = 0;
    for (const dir of templateDirs) {
      if (!existsSync(dir)) continue;
      for (const abs of walk(dir, '.md')) {
        const text = readText(abs);
        if (isDraft(text)) continue;
        scanned += 1;
        for (const issue of templateIssues(text, { loaderFiles, pluginVersion: info.version })) {
          issues.push({ severity: issue.severity, message: `${posix(relative(root, abs))}：${issue.message}` });
        }
      }
    }
    for (const issue of issues) {
      add(issue.severity, `模板与插件不兼容：${issue.message}`,
        issue.severity === 'error' ? '/devflow:init 重建 loader，或升级插件后重跑 /devflow:sync' : '升级 devflow 插件后重跑 /devflow:sync');
    }
    if (!issues.length && scanned) add('ok', `模板与当前插件兼容（扫描 ${scanned} 个文件）`);
  }

  if (config) {
    const overviewFile = join(root, OVERVIEW_FILE);
    if (!existsSync(overviewFile)) {
      add('warn', `缺少 ${OVERVIEW_FILE}，运行 /devflow:onboard 生成项目概览`, '/devflow:onboard');
    } else {
      const text = readText(overviewFile);
      const starts = text.split(AUTO_START).length - 1;
      const ends = text.split(AUTO_END).length - 1;
      if (starts !== 1 || ends !== 1) {
        add('warn', `项目概览自动段标记异常（start=${starts}，end=${ends}），运行 /devflow:onboard 重建`, '/devflow:onboard');
      } else {
        add('ok', '项目概览标记块完整');
        const hub = readHubFacts(root);
        const facts = scanFacts(root, { subprojectPaths: hub.subprojects.map((s) => s.path) });
        const expected = factsFingerprint({ facts, subprojects: hub.subprojects, rootTest: hub.rootTest });
        const actual = readFactsFingerprint(text);
        if (!actual) {
          add('warn', '项目概览缺少事实指纹，运行 /devflow:onboard 重建', '/devflow:onboard');
        } else if (actual !== expected) {
          add('warn', '项目概览与当前结构不一致，运行 /devflow:onboard 重建', '/devflow:onboard');
        } else {
          add('ok', '项目概览与当前项目结构一致');
        }
      }
    }
  }

  if (config) {
    const commands = [];
    if (config.defaults?.testCommand) {
      commands.push({ label: 'defaults', command: config.defaults.testCommand });
    }
    for (const [name, sub] of Object.entries(config.subprojects || {})) {
      if (sub?.testCommand) commands.push({ label: name, command: sub.testCommand });
    }
    const missing = [];
    const localIssues = [];
    for (const { label, command } of commands) {
      for (const tool of commandTools(command)) {
        if (!KNOWN_TOOLS.has(tool)) continue;
        if (!toolExists(tool)) missing.push(`${label} 的测试命令依赖 ${tool}，PATH 中找不到：${command}`);
      }
      localIssues.push(...localCommandIssues(root, label, command));
    }
    for (const issue of localIssues) add('error', issue);
    if (missing.length) for (const m of missing) add('warn', m, '安装缺失的工具，或修改 .claude/hub/hub.yaml 中对应子项目的 testCommand');
    else if (commands.length) add('ok', '测试命令依赖的工具均可用');
  }

  const gitignore = join(root, '.gitignore');
  if (!existsSync(gitignore)) {
    add('warn', '缺少 .gitignore，运行 /devflow:init 会补上 devflow 片段', '/devflow:init');
  } else if (!/# >>> devflow/.test(readText(gitignore))) {
    add('warn', '.gitignore 缺少 devflow 片段，重新运行 /devflow:init 可补上', '/devflow:init');
  } else {
    const ignore = readText(gitignore);
    if (!/docs\/devflow\/\*\/\.archive\//.test(ignore)) {
      add('warn', '.gitignore 的 devflow 片段缺少归档忽略规则，重新运行 /devflow:init 可更新', '/devflow:init');
    } else {
      add('ok', '.gitignore 含 devflow 片段');
    }
  }

  const loaderFiles = Object.entries(LOADERS);
  const missingLoaders = loaderFiles.filter(([f]) => !existsSync(join(root, 'scripts', f))).map(([f]) => f);
  const staleLoaders = loaderFiles
    .filter(([f, target]) => {
      const dst = join(root, 'scripts', f);
      return existsSync(dst) && normalizeEol(readText(dst)) !== normalizeEol(loaderSource(target));
    })
    .map(([f]) => f);
  if (missingLoaders.length) {
    add('warn', `缺少 loader：${missingLoaders.map((f) => `scripts/${f}`).join('、')}，重新运行 /devflow:init 可重建`, '/devflow:init');
  } else if (staleLoaders.length) {
    add('warn', `loader 内容过期：${staleLoaders.map((f) => `scripts/${f}`).join('、')}，重新运行 /devflow:init 可刷新`, '/devflow:init');
  } else {
    add('ok', 'loader 脚本齐全且为最新');
  }

  const manifestFile = join(root, '.claude', '.hub-manifest.json');
  const manifest = readJson(manifestFile);
  if (!manifest) {
    add('warn', existsSync(manifestFile)
      ? '.claude/.hub-manifest.json 损坏，运行 node scripts/devflow-gen.mjs 重建'
      : '缺少 .claude/.hub-manifest.json，运行 node scripts/devflow-gen.mjs', 'node scripts/devflow-gen.mjs');
  } else {
    add('ok', `生成账本包含 ${manifest.skills?.length || 0} 个技能`);
  }
  const sourcesFile = join(root, '.claude', '.hub-sources.json');
  const sources = readJson(sourcesFile);
  if (!sources) {
    add('warn', existsSync(sourcesFile)
      ? '.claude/.hub-sources.json 损坏，运行 /devflow:sync 可重建'
      : '缺少 .claude/.hub-sources.json，运行 /devflow:sync 可重建', '/devflow:sync');
  } else {
    add('ok', `阶段源账本记录 ${Object.keys(sources.files || {}).length} 个文件`);
    const schema = Number(sources.schemaVersion ?? 2);
    if (schema < 3) {
      add('warn', `模板来源账本为 v${schema}，缺少来源信息，运行 /devflow:sync 升级到 v3`, '/devflow:sync');
    } else if (schema > 3) {
      add('warn', `模板来源账本为 v${schema}，高于当前支持的 v3，可能由更新版本生成`, '升级 devflow 插件后重试');
    }
  }
  if (manifest?.skills?.length) {
    const withResources = manifest.skills.filter((s) => Array.isArray(s.resources) && s.resources.length).length;
    add('ok', `阶段资源清单：${manifest.skills.length} 个技能，${withResources} 个含 references/templates`);
  }
  if (Array.isArray(manifest?.shared)) {
    const issues = [];
    for (const entry of manifest.shared) {
      const rel = String(entry?.path || '');
      if (!rel) { issues.push('账本含空共享规则条目'); continue; }
      const abs = join(root, ...rel.split('/'));
      if (!isPathInside(join(root, '.claude', 'hub', '_shared'), abs)) {
        issues.push(`共享规则路径越界：${rel}`);
      } else if (!existsSync(abs)) {
        issues.push(`共享规则缺失：${rel}`);
      }
    }
    if (issues.length) {
      for (const issue of issues) add('warn', issue);
      addHint('运行 /devflow:sync 补齐共享规则，或 node scripts/devflow-gen.mjs 刷新账本；正文修改不需要重新生成');
    } else if (manifest.shared.length) {
      add('ok', `共享规则与账本一致（${manifest.shared.length} 个）`);
    }
  }

  const managed = new Map((manifest?.skills || []).map((s) => [s.name, s]));
  for (const [name, s] of managed) {
    const target = safeManifestTarget(root, s.target);
    if (!target) {
      add('warn', `${name} 的投影目标越界或非法：${s.target}`, '检查 .claude/.hub-manifest.json 的 target；无法修复时删除该账本后运行 node scripts/devflow-gen.mjs');
      continue;
    }
    if (!existsSync(target)) {
      add('warn', `${name} 投影缺失，建议重新生成`, 'node scripts/devflow-gen.mjs');
    } else if (s.hash && contentHash(readText(target)) !== s.hash) {
      add('warn', `${name} 投影被手改或过期，建议重新生成`, 'node scripts/devflow-gen.mjs');
    } else {
      add('ok', `${name} 投影一致`);
    }
    const source = join(root, ...String(s.source).split('/'));
    if (!isPathInside(join(root, '.claude', 'hub', 'stages'), source)) {
      add('error', `${name} 源路径越界：${s.source}`);
    } else if (!existsSync(source)) {
      add('error', `${name} 源文件缺失：${s.source}`);
    }
    const sourceDir = join(root, ...String(s.source).split('/').slice(0, -1));
    const resources = Array.isArray(s.resources) ? s.resources : [];
    const lost = resources.filter((rel) => !existsSync(join(sourceDir, ...String(rel).split('/'))));
    if (lost.length) add('warn', `${name} 阶段资源缺失：${lost.join('、')}`, '运行 /devflow:sync（或 /devflow:init）补齐阶段资源');
  }

  const skillsDir = join(root, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('devflow-')) continue;
      if (!managed.has(entry.name)) add('warn', `.claude/skills/${entry.name} 不在账本中（可能是手写，未处理）`, '确认该投影是否手写；非手写时删除目录后运行 node scripts/devflow-gen.mjs');
    }
  }

  const hooks = join(root, '.claude', 'settings.json');
  if (existsSync(hooks)) {
    const settings = readJson(hooks, {});
    if (settings?.hooks) {
      add('ok', '项目 settings.json 含自定义 hooks（devflow hooks 由插件 hooks/hooks.json 提供）');
    } else {
      add('ok', '项目未覆盖 hooks（devflow hooks 由插件 hooks/hooks.json 提供）');
    }
  }

  checkPluginHooks(add, pluginRoot);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  if (existsSync(stateFile)) {
    const state = readJson(stateFile, {});
    const tested = Date.parse(state.lastTestPassedAt || '');
    const changed = Date.parse(state.lastChangeAt || '');
    if (state.testsPending) {
      add('warn', '有改动尚未验证；完成测试后运行 /devflow:test', '/devflow:test');
    } else if (Number.isNaN(tested)) {
      add('warn', '还没有记录测试通过；/devflow:test 会写入', '/devflow:test');
    } else if (!Number.isNaN(changed) && changed > tested) {
      add('warn', `最近改动晚于测试通过时间（${state.lastChangeAt}），建议重新跑测试`, '/devflow:test');
    } else {
      add('ok', `最近一次测试通过：${state.lastTestPassedAt}`);
    }
  }

  return finish();
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
