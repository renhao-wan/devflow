#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import {
  pluginInfo, findPluginRoot, satisfies, readText, sha256, log,
  posix, isMain, projectRoot, argValue, hasFlag, parseYaml,
  readMeta, isPluginCache, isValidPluginRoot, samePath, isValidStageName,
} from './lib/common.mjs';

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

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const json = hasFlag(argv, '--json');
  const rows = [];
  const add = (status, message) => rows.push({ status, message });

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
    if (Number(config.version) !== 1) add('warn', `hub.yaml version 应为 1，当前为 ${config.version}`);
    if (Array.isArray(config.stages)) {
      const bad = config.stages.filter((s) => !isValidStageName(s));
      if (bad.length) add('error', `hub.yaml stages 含非法阶段名：${bad.join('、')}`);
      if (new Set(config.stages).size !== config.stages.length) add('warn', 'hub.yaml stages 有重复项');
    }
    const blocked = config.upstream?.blocklist;
    if (blocked != null && !Array.isArray(blocked)) add('warn', 'hub.yaml upstream.blocklist 应为列表');
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

  const meta = readMeta(root);
  if (meta?.pluginVersion && info?.version && meta.pluginVersion !== info.version) {
    add('warn', `.devflow.json 记录的插件版本 ${meta.pluginVersion} 与当前 ${info.version} 不一致，建议运行 /devflow:sync 或重跑 /devflow:init`);
  }
  if (meta?.pluginRoot && pluginRoot && !samePath(meta.pluginRoot, pluginRoot)) {
    if (isPluginCache(meta.pluginRoot)) {
      add('ok', '插件路径已更新（升级或缓存变化）；阶段模板可用 /devflow:sync 同步');
    } else {
      add('warn', `记录的插件路径与当前不一致：${posix(meta.pluginRoot)} → ${posix(pluginRoot)}，可重跑 /devflow:init 刷新记录`);
    }
  } else if (pluginRoot && isPluginCache(pluginRoot)) {
    add('ok', '运行于安装缓存；回灌需 --plugin-root 或 pluginSourceRoot');
  }
  if (meta?.pluginSourceRoot) {
    if (isValidPluginRoot(meta.pluginSourceRoot)) {
      add('ok', `回灌源码仓库：${posix(meta.pluginSourceRoot)}`);
    } else {
      add('warn', `回灌源码仓库不存在：${posix(meta.pluginSourceRoot)}，请重跑 /devflow:init --source-root <路径>`);
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
    if (missing.length) for (const m of missing) add('warn', m);
    else if (commands.length) add('ok', '测试命令依赖的工具均可用');
  }

  const gitignore = join(root, '.gitignore');
  if (!existsSync(gitignore)) {
    add('warn', '缺少 .gitignore，运行 /devflow:init 会补上 devflow 片段');
  } else if (!/# >>> devflow/.test(readText(gitignore))) {
    add('warn', '.gitignore 缺少 devflow 片段，重新运行 /devflow:init 可补上');
  } else {
    add('ok', '.gitignore 含 devflow 片段');
  }

  const loaders = ['devflow-gen.mjs', 'devflow-doctor.mjs', 'devflow-upstream.mjs', 'devflow-test.mjs'];
  const missingLoaders = loaders.filter((f) => !existsSync(join(root, 'scripts', f)));
  if (missingLoaders.length) {
    add('warn', `缺少 loader：${missingLoaders.map((f) => `scripts/${f}`).join('、')}，重新运行 /devflow:init 可重建`);
  } else {
    add('ok', 'loader 脚本齐全');
  }

  const manifestFile = join(root, '.claude', '.hub-manifest.json');
  const manifest = readJson(manifestFile);
  if (!manifest) add('warn', '缺少 .claude/.hub-manifest.json，运行 node scripts/devflow-gen.mjs');
  else add('ok', `生成账本包含 ${manifest.skills?.length || 0} 个技能`);
  if (manifest?.skills?.length) {
    const withResources = manifest.skills.filter((s) => Array.isArray(s.resources) && s.resources.length).length;
    add('ok', `阶段资源清单：${manifest.skills.length} 个技能，${withResources} 个含 references/templates`);
  }

  const managed = new Map((manifest?.skills || []).map((s) => [s.name, s]));
  for (const [name, s] of managed) {
    const target = join(root, ...String(s.target).split('/'));
    if (!existsSync(target)) {
      add('warn', `${name} 投影缺失，建议重新生成`);
    } else if (s.hash && sha256(readText(target)) !== s.hash) {
      add('warn', `${name} 投影被手改或过期，建议重新生成`);
    } else {
      add('ok', `${name} 投影一致`);
    }
    const source = join(root, ...String(s.source).split('/'));
    if (!existsSync(source)) add('error', `${name} 源文件缺失：${s.source}`);
    const sourceDir = join(root, ...String(s.source).split('/').slice(0, -1));
    const resources = Array.isArray(s.resources) ? s.resources : [];
    const lost = resources.filter((rel) => !existsSync(join(sourceDir, ...String(rel).split('/'))));
    if (lost.length) add('warn', `${name} 阶段资源缺失：${lost.join('、')}`);
  }

  const skillsDir = join(root, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('devflow-')) continue;
      if (!managed.has(entry.name)) add('warn', `.claude/skills/${entry.name} 不在账本中（可能是手写，未处理）`);
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

  try {
    const pluginHooks = join(pluginRoot, 'hooks', 'hooks.json');
    if (existsSync(pluginHooks)) {
      const h = readJson(pluginHooks, {});
      const count = Object.values(h.hooks || {}).reduce((n, arr) => n + arr.length, 0);
      add('ok', `插件 hooks 已注册 ${count} 组`);
      for (const script of ['guard-dangerous.mjs', 'track-changes.mjs', 'check-tests.mjs', 'load-hub.mjs']) {
        const p = join(pluginRoot, 'hooks', 'scripts', script);
        if (!existsSync(p)) add('error', `缺少 hooks 脚本 ${script}`);
      }
    } else {
      add('warn', '插件未提供 hooks.json');
    }
  } catch {
    add('warn', '无法检查 hooks');
  }

  const stateFile = join(root, '.claude', '.devflow-state.json');
  if (existsSync(stateFile)) {
    const state = readJson(stateFile, {});
    if (state.lastTestPassedAt) add('ok', `最近一次测试通过：${state.lastTestPassedAt}`);
    else add('warn', '还没有记录测试通过；/devflow:test 会写入');
  }

  if (json) {
    console.log(JSON.stringify({ root: posix(root), rows }, null, 2));
  } else {
    for (const r of rows) log(r.status, r.message);
    const errors = rows.filter((r) => r.status === 'error').length;
    const warns = rows.filter((r) => r.status === 'warn').length;
    console.log(`\n${errors} 个错误，${warns} 个提醒。`);
    if (warns) console.log('建议：node scripts/devflow-gen.mjs');
  }
  if (rows.some((r) => r.status === 'error')) process.exitCode = 1;
  return rows;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
