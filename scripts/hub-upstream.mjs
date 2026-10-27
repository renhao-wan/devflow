#!/usr/bin/env node
import { existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadHub, pluginInfo, findPluginRoot, argValue, hasFlag, readText, writeText,
  writeAtomic, bumpPatch, log, posix, isMain, projectRoot, ensureDir,
} from './lib/common.mjs';

const PRIVATE_PATTERNS = [
  /[A-Za-z]:[\\/]/,            // Windows 绝对路径
  /\/Users\/[^/]+/,            // macOS 家目录
  /\/home\/[^/]+/,             // Linux 家目录
  /192\.168\.\d+\.\d+/,        // 内网 IP
  /10\.\d+\.\d+\.\d+/,
  /\.corp\b|\.internal\b/i,
];

function classify(text, config) {
  const hints = [];
  for (const p of PRIVATE_PATTERNS) if (p.test(text)) hints.push(String(p));
  const blocked = config?.upstream?.blocklist;
  if (Array.isArray(blocked)) {
    for (const word of blocked) if (text.includes(word)) hints.push(word);
  }
  for (const name of Object.keys(config?.subprojects || {})) {
    if (text.includes(name)) hints.push(`子项目名 ${name}`);
  }
  return hints.length ? { type: 'project-local', hints } : { type: 'reusable', hints: [] };
}

function showDiff(from, to, label) {
  const result = spawnSync('git', ['diff', '--no-index', '--', from, to], { encoding: 'utf8' });
  if (result.status === 0 || result.status === 1) {
    console.log(`\n--- ${label} ---`);
    console.log(result.stdout || '（内容一致）');
  } else {
    console.log(`\n--- ${label} ---（git 不可用，仅显示文件）`);
    console.log(`${posix(from)} → ${posix(to)}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const root = projectRoot(argValue(argv, '--root', process.cwd()));
  const stage = argValue(argv, '--stage', null);
  const apply = hasFlag(argv, '--apply');
  if (!stage) throw new Error('必须指定 --stage <req|plan|implement|test|review|debug>');

  const { config } = loadHub(root);
  const pluginRoot = argValue(argv, '--plugin-root', null) || findPluginRoot(root);
  const info = pluginInfo(pluginRoot);

  const srcDir = join(root, '.claude', 'hub', 'stages', stage);
  const dstDir = join(pluginRoot, 'templates', 'stages', stage);
  if (!existsSync(srcDir)) throw new Error(`项目里没有该阶段：${posix(srcDir)}`);

  const files = readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isFile());
  if (!files.length) throw new Error(`阶段目录为空：${posix(srcDir)}`);

  let localCount = 0;
  const reusable = [];
  for (const f of files) {
    const src = join(srcDir, f.name);
    const dst = join(dstDir, f.name);
    const text = readText(src);
    const verdict = classify(text, config);
    console.log(`${verdict.type === 'reusable' ? '[可回灌]' : '[项目专属]'} ${stage}/${f.name}${verdict.hints.length ? `（${verdict.hints.join('、')}）` : ''}`);
    if (verdict.type === 'reusable') reusable.push({ src, dst, name: f.name });
    else localCount += 1;
    if (existsSync(dst)) showDiff(dst, src, `${stage}/${f.name}（插件 → 项目）`);
  }

  if (!apply) {
    console.log(`\n预览完成：${reusable.length} 个可回灌，${localCount} 个项目专属。`);
    console.log('加 --apply 才会写入插件模板并 bump 版本。');
    return { stage, reusable: reusable.length, local: localCount, applied: false };
  }

  if (!reusable.length) {
    console.log('没有可回灌内容，未修改插件。');
    return { stage, reusable: 0, local: localCount, applied: false };
  }

  ensureDir(dstDir);
  for (const f of reusable) copyFileSync(f.src, f.dst);

  const logFile = join(pluginRoot, 'templates', 'stages', '_feedback-log.md');
  const entry = `\n## ${new Date().toISOString()} · ${stage}\n\n- 回灌文件：${reusable.map((f) => f.name).join('、')}\n- 项目：${posix(root)}\n- 插件版本：${info.version} → ${bumpPatch(info.version)}\n`;
  writeText(logFile, `${existsSync(logFile) ? readText(logFile) : '# 回灌日志\n'}${entry}`);

  const nextVersion = bumpPatch(info.version);
  const pluginFile = join(pluginRoot, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(readText(pluginFile));
  plugin.version = nextVersion;
  writeAtomic(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);

  const changelog = join(pluginRoot, 'CHANGELOG.md');
  const old = existsSync(changelog) ? readText(changelog) : '# Changelog\n';
  const block = `\n## ${nextVersion}\n\n- 从项目回灌 ${stage} 阶段模板（${reusable.map((f) => f.name).join('、')}）\n`;
  const updated = old.replace(/^# Changelog\n?/, `# Changelog\n${block}`);
  writeAtomic(changelog, updated);

  log('ok', `已回灌 ${reusable.length} 个文件，插件版本 ${info.version} → ${nextVersion}`);
  log('ok', `回灌日志：${posix(logFile)}`);
  return { stage, reusable: reusable.length, local: localCount, applied: true, version: nextVersion };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
