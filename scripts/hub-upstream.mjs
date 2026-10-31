#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  pluginInfo, argValue, hasFlag, readText, writeText,
  writeAtomic, log, posix, isMain, projectRoot, ensureDir, sha256,
  walk, relPosix, resolveUpstreamRoot, isPluginCache, cacheGuardMessage,
  isGeneratedArtifact, loadHub, bumpVersion,
} from './lib/common.mjs';

const PRIVATE_PATTERNS = [
  /(?<![A-Za-z])[A-Za-z]:[\\/]/, // Windows 盘符路径（负向后行断言排除 URL 中的 ://）
  /\/Users\/[^/]+/,            // macOS 家目录
  /\/home\/[^/]+/,             // Linux 家目录
  /\b192\.168(?:\.\d{1,3}){2}\b/, // 内网 IP
  /\b10(?:\.\d{1,3}){3}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/,
  /\b127\.0\.0\.1\b/,
  /\b169\.254(?:\.\d{1,3}){2}\b/,
  /\.corp\b|\.internal\b/i,
];

// 回灌会把项目内容写进插件仓库并提交，命中即按项目专属处理，避免把凭据带出去。
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i, // URL 中 user:pass@
];

/**
 * 名称匹配：ASCII 名称要求词边界（避免 api 命中 rapid/capital），
 * 含非 ASCII（中文等）的名称边界无意义，退回普通包含。
 */
function nameHit(text, name) {
  const word = String(name).trim();
  if (!word) return false;
  if (!/^[\x00-\x7F]+$/.test(word)) return text.includes(word);
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`).test(text);
}

function classify(text, config) {
  const hints = new Set();
  for (const p of PRIVATE_PATTERNS) if (p.test(text)) hints.add(String(p));
  if (SECRET_PATTERNS.some((p) => p.test(text))) hints.add('疑似密钥或凭据');
  const blocked = config?.upstream?.blocklist;
  if (Array.isArray(blocked)) {
    for (const word of blocked) if (nameHit(text, word)) hints.add(word);
  }
  for (const name of Object.keys(config?.subprojects || {})) {
    if (nameHit(text, name)) hints.add(`子项目名 ${name}`);
  }
  const list = [...hints];
  return list.length ? { type: 'project-local', hints: list } : { type: 'reusable', hints: [] };
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

function bumpKind(argv) {
  const kind = argValue(argv, '--bump', 'patch');
  if (!['patch', 'minor', 'major'].includes(kind)) {
    throw new Error(`--bump 只支持 patch|minor|major，收到：${kind}`);
  }
  return kind;
}

/** 插件版本有多个落盘点，升级时保持同步。plugin.json 是权威来源，其余是镜像。 */
function updateVersionFiles(pluginRoot, next) {
  const targets = [
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, 'package.json'),
    join(pluginRoot, '.claude-plugin', 'marketplace.json'),
  ];
  let pluginName = null;
  try {
    pluginName = JSON.parse(readText(join(pluginRoot, '.claude-plugin', 'plugin.json'))).name;
  } catch { /* 缺失时按唯一插件处理 */ }

  const changed = [];
  for (const file of targets) {
    if (!existsSync(file)) continue;
    let data;
    try {
      data = JSON.parse(readText(file));
    } catch {
      continue;
    }
    if (file.endsWith('marketplace.json')) {
      data.metadata = { ...(data.metadata || {}), version: next };
      if (Array.isArray(data.plugins)) {
        for (const plugin of data.plugins) {
          if (!pluginName || plugin.name === pluginName) plugin.version = next;
        }
      }
    } else {
      data.version = next;
    }
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    changed.push(posix(file));
  }
  return changed;
}

export async function main(argv = process.argv.slice(2)) {
  const root = projectRoot(argValue(argv, '--root', process.cwd()));
  const stage = argValue(argv, '--stage', null);
  const apply = hasFlag(argv, '--apply');
  const kind = bumpKind(argv);
  if (!stage) throw new Error('必须指定 --stage <req|plan|implement|test|review|debug>');

  const { config } = loadHub(root);
  const pluginRoot = resolveUpstreamRoot(root, argValue(argv, '--plugin-root', null));
  const info = pluginInfo(pluginRoot);
  const cacheTarget = isPluginCache(pluginRoot);

  const srcDir = join(root, '.claude', 'hub', 'stages', stage);
  const dstDir = join(pluginRoot, 'templates', 'stages', stage);
  if (!existsSync(srcDir)) throw new Error(`项目里没有该阶段：${posix(srcDir)}`);

  const files = walk(srcDir)
    .map((abs) => ({ abs, rel: relPosix(srcDir, abs) }))
    .filter((f) => !isGeneratedArtifact(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  if (!files.length) throw new Error(`阶段目录为空：${posix(srcDir)}`);

  let localCount = 0;
  const reusable = [];
  for (const f of files) {
    const src = f.abs;
    const dst = join(dstDir, ...f.rel.split('/'));
    const text = readText(src);
    const verdict = classify(text, config);
    const changed = !existsSync(dst) || sha256(readText(dst)) !== sha256(text);
    console.log(`${verdict.type === 'reusable' ? '[可回灌]' : '[项目专属]'} ${stage}/${f.rel}${verdict.hints.length ? `（${verdict.hints.join('、')}）` : ''}${verdict.type === 'reusable' && !changed ? '（与插件一致）' : ''}`);
    if (verdict.type === 'reusable') reusable.push({ src, dst, name: f.rel, changed });
    else localCount += 1;
    // 项目专属内容可能含密钥，不回显 diff，避免把凭据打印到终端或日志
    if (verdict.type === 'reusable' && existsSync(dst) && changed) showDiff(dst, src, `${stage}/${f.rel}（插件 → 项目）`);
  }

  const pending = reusable.filter((f) => f.changed);

  if (!apply) {
    console.log(`\n预览完成：${reusable.length} 个可回灌（${pending.length} 个有变化），${localCount} 个项目专属。`);
    console.log('加 --apply 才会写入插件模板并升级版本。');
    if (cacheTarget) log('warn', `目标是安装缓存（${posix(pluginRoot)}），--apply 会被拒绝，请用 --plugin-root 指向源码仓库。`);
    return { stage, reusable: reusable.length, pending: pending.length, local: localCount, applied: false };
  }

  if (cacheTarget) throw new Error(cacheGuardMessage(pluginRoot));

  if (!pending.length) {
    console.log(reusable.length ? '可回灌文件与插件模板一致，未修改插件。' : '没有可回灌内容，未修改插件。');
    return { stage, reusable: reusable.length, pending: 0, local: localCount, applied: false };
  }

  ensureDir(dstDir);
  for (const f of pending) {
    ensureDir(dirname(f.dst));
    copyFileSync(f.src, f.dst);
  }

  const nextVersion = bumpVersion(info.version, kind);
  const logFile = join(pluginRoot, 'templates', 'stages', '_feedback-log.md');
  const entry = `\n## ${new Date().toISOString()} · ${stage}\n\n- 回灌文件：${pending.map((f) => f.name).join('、')}\n- 项目：${basename(root)}（本地路径不记录）\n- 插件版本：${info.version} → ${nextVersion}\n`;
  writeText(logFile, `${existsSync(logFile) ? readText(logFile) : '# 回灌日志\n'}${entry}`);

  updateVersionFiles(pluginRoot, nextVersion);

  const changelog = join(pluginRoot, 'CHANGELOG.md');
  const old = existsSync(changelog) ? readText(changelog) : '';
  const block = `\n## ${nextVersion}\n\n- 从项目回灌 ${stage} 阶段模板（${pending.map((f) => f.name).join('、')}）\n`;
  // 标题缺失时补上再插入，避免 replace 不匹配导致版本条目被静默丢弃。
  const withTitle = /^# Changelog\b/m.test(old) ? old : `# Changelog\n${old}`;
  const heading = /^# Changelog[^\n]*\n?/m.exec(withTitle);
  const versionRe = new RegExp(`^##\\s+${nextVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm');
  const updated = versionRe.test(withTitle)
    ? withTitle
    : heading
      ? `${withTitle.slice(0, heading.index + heading[0].length)}${block}${withTitle.slice(heading.index + heading[0].length)}`
      : `${withTitle}${block}`;
  writeAtomic(changelog, updated);

  log('ok', `已回灌 ${pending.length} 个文件，插件版本 ${info.version} → ${nextVersion}`);
  log('ok', `回灌日志：${posix(logFile)}`);
  return { stage, reusable: reusable.length, pending: pending.length, local: localCount, applied: true, version: nextVersion };
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
