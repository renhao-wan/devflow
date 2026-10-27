#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  pluginInfo, findPluginRoot, satisfies, readText, sha256, log,
  posix, isMain, projectRoot, argValue, hasFlag, parseYaml,
} from './lib/common.mjs';

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

  let pluginRoot = null;
  try {
    pluginRoot = findPluginRoot(root);
    const info = pluginInfo(pluginRoot);
    add('ok', `插件 ${info.name}@${info.version}（${posix(pluginRoot)}）`);
  } catch (err) {
    add('error', err.message);
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

  const manifestFile = join(root, '.claude', '.hub-manifest.json');
  const manifest = readJson(manifestFile);
  if (!manifest) add('warn', '缺少 .claude/.hub-manifest.json，运行 node scripts/devflow-gen.mjs');
  else add('ok', `生成账本包含 ${manifest.skills?.length || 0} 个技能`);

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
    if (settings?.hooks) add('ok', '项目 settings.json 包含 hooks 配置');
    else add('ok', '项目 settings.json 存在，未覆盖 hooks');
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
