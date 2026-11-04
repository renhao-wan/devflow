import {
  existsSync, readdirSync, copyFileSync, appendFileSync, mkdtempSync, rmSync, statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  readText, writeAtomic, ensureDir, walk, relPosix, isGeneratedArtifact,
  normalizeEol, isPathInside, isRealPathInside, posix,
  parseFrontmatter,
} from './common.mjs';
import { isValidStackName } from './stacks.mjs';

export const LOG_JSONL = '.devflow/upstream-log.jsonl';
export const LOG_MD = 'docs/upstream-log.md';
export const BACKUP_ROOT = '.devflow/backups';
export const JOURNAL = '.devflow/upstream-journal.json';

export const LOCAL_BEGIN = '<!-- devflow:local';
export const LOCAL_END = '<!-- /devflow:local';
export const REUSABLE_BEGIN = '<!-- devflow:reusable';
export const REUSABLE_END = '<!-- /devflow:reusable';

const PRIVATE_PATTERNS = [
  /(?<![A-Za-z])[A-Za-z]:[\\/]/, // Windows 盘符路径（负向后行断言排除 URL 中的 ://）
  /\/Users\/[^/]+/,            // macOS 家目录
  /\/home\/[^/]+/,             // Linux 家目录
  /\b192\.168(?:\.\d{1,3}){2}\b/,
  /\b10(?:\.\d{1,3}){3}\b/,
  /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/,
  /\b127\.0\.0\.1\b/,
  /\b169\.254(?:\.\d{1,3}){2}\b/,
  /\.corp\b|\.internal\b/i,
];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/,
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i, // URL 中 user:pass@
];

/**
 * 名称匹配：ASCII 名称要求词边界（避免 api 命中 rapid/capital），
 * 含非 ASCII（中文等）的名称边界无意义，退回普通包含。
 */
export function nameHit(text, name) {
  const word = String(name).trim();
  if (!word) return false;
  if (!/^[\x00-\x7F]+$/.test(word)) return text.includes(word);
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`).test(text);
}

export function scanLine(line, config) {
  const hints = new Set();
  if (PRIVATE_PATTERNS.some((p) => p.test(line))) hints.add('私有路径或内网地址');
  if (SECRET_PATTERNS.some((p) => p.test(line))) hints.add('疑似密钥或凭据');
  const blocked = config?.upstream?.blocklist;
  if (Array.isArray(blocked)) {
    for (const word of blocked) if (nameHit(line, word)) hints.add(`blocklist 关键词 ${word}`);
  }
  for (const name of Object.keys(config?.subprojects || {})) {
    if (nameHit(line, name)) hints.add(`子项目名 ${name}`);
  }
  return [...hints];
}

function collapseBlank(text) {
  return text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
}

/**
 * 分类单个文本：
 * - 显式 `devflow:local` 块整块剔除；
 * - 显式 `devflow:reusable` 块保留但仍做敏感扫描；
 * - 未标记内容按行扫描，命中行剔除并记录；
 * - 剔除后没有正文时判为整体项目专属。
 */
export function classifyText(text, config) {
  const lines = normalizeEol(text).split('\n');
  const kept = [];
  const removed = [];
  const hints = new Set();
  let mode = null;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(LOCAL_BEGIN)) { mode = 'local'; continue; }
    if (trimmed.startsWith(LOCAL_END)) { if (mode === 'local') mode = null; continue; }
    if (trimmed.startsWith(REUSABLE_BEGIN)) { mode = 'reusable'; continue; }
    if (trimmed.startsWith(REUSABLE_END)) { if (mode === 'reusable') mode = null; continue; }

    if (mode === 'local') {
      removed.push({ line: i + 1, reason: '显式标记为项目专属' });
      continue;
    }
    const found = scanLine(lines[i], config);
    if (found.length) {
      for (const hint of found) hints.add(hint);
      removed.push({ line: i + 1, reason: found.join('、') });
      continue;
    }
    kept.push(lines[i]);
  }

  const content = collapseBlank(kept.join('\n'));
  const body = content.replace(/^---[\s\S]*?---\s*/, '').trim();
  return {
    type: body ? 'reusable' : 'local',
    content,
    hints: [...hints],
    removed,
  };
}

export function resolveUnits(root, {
  stage = null, stages = [], shared = false, stacks = [], all = false,
} = {}) {
  const units = [];
  const seen = new Set();
  const add = (unit) => {
    const key = `${unit.kind}:${unit.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    units.push(unit);
  };
  const addStage = (name) => add({
    kind: 'stage',
    name,
    sourceRel: `.claude/hub/stages/${name}`,
    targetRel: `templates/stages/${name}`,
  });
  const addStack = (name) => add({
    kind: 'stack',
    name,
    sourceRel: `.claude/hub/stacks/${name}`,
    targetRel: `templates/stacks/${name}`,
  });

  for (const name of [...stages, ...(stage ? [stage] : [])]) addStage(name);
  for (const name of stacks) addStack(name);
  const sharedDir = join(root, '.claude', 'hub', '_shared');
  if (shared || (all && existsSync(sharedDir))) {
    add({
      kind: 'shared',
      name: 'shared',
      sourceRel: '.claude/hub/_shared',
      targetRel: 'templates/shared',
    });
  }
  if (all) {
    const dir = join(root, '.claude', 'hub', 'stages');
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) addStage(entry.name);
      }
    }
    const stacksDir = join(root, '.claude', 'hub', 'stacks');
    if (existsSync(stacksDir)) {
      for (const entry of readdirSync(stacksDir, { withFileTypes: true })) {
        // 只回灌 hub.yaml 能引用的合法栈名，避免把无法声明的目录写进模板库。
        if (entry.isDirectory() && !entry.name.startsWith('.') && isValidStackName(entry.name)) {
          addStack(entry.name);
        }
      }
    }
  }
  if (!units.length) throw new Error('必须指定 --stage <name>、--shared、--stack <name> 或 --all');
  return units;
}

const UNIT_LABELS = { shared: '共享规则目录', stage: '阶段', stack: '技术栈' };

export function planUnit(root, pluginRoot, unit, config) {
  const sourceDir = join(root, ...unit.sourceRel.split('/'));
  if (!existsSync(sourceDir)) {
    const label = UNIT_LABELS[unit.kind] || unit.kind;
    throw new Error(`项目里没有${unit.kind === 'shared' ? label : `${label} ${unit.name}`}：${posix(sourceDir)}`);
  }
  const files = walk(sourceDir)
    .map((abs) => ({ abs, rel: relPosix(sourceDir, abs) }))
    .filter((f) => !isGeneratedArtifact(f.rel))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  if (!files.length) throw new Error(`目录为空：${posix(sourceDir)}`);

  const targetDir = join(pluginRoot, ...unit.targetRel.split('/'));
  const results = files.map((file) => {
    const text = readText(file.abs);
    if (text.includes('\0')) return { ...file, skipped: true, reason: '二进制文件' };
    const verdict = classifyText(text, config);
    const targetAbs = join(targetDir, ...file.rel.split('/'));
    const changed = verdict.type === 'reusable'
      && (!existsSync(targetAbs) || normalizeEol(readText(targetAbs)) !== normalizeEol(verdict.content));
    return { ...file, targetAbs, verdict, changed };
  });

  return {
    unit,
    sourceDir,
    targetDir,
    files: results,
    pending: results.filter((f) => f.verdict?.type === 'reusable' && f.changed),
    local: results.filter((f) => f.verdict?.type === 'local'),
  };
}

export function planUnits(root, pluginRoot, units, config) {
  return units.map((unit) => planUnit(root, pluginRoot, unit, config));
}

export function backupFile(pluginRoot, id, rel) {
  const abs = join(pluginRoot, ...rel.split('/'));
  if (!existsSync(abs) || !statSync(abs).isFile()) return false;
  const dest = join(pluginRoot, ...BACKUP_ROOT.split('/'), id, ...rel.split('/'));
  // 保留首次备份：中断续做时不能用已写入的新内容覆盖旧快照，否则 --revert 失效。
  if (existsSync(dest)) return true;
  ensureDir(dirname(dest));
  copyFileSync(abs, dest);
  return true;
}

export function applyPlan(plan, pluginRoot, { backupId = null } = {}) {
  const written = [];
  const created = [];
  for (const file of plan.pending) {
    if (!isPathInside(pluginRoot, file.targetAbs) || !isRealPathInside(pluginRoot, file.targetAbs)) {
      throw new Error(`回灌目标越界：${posix(file.targetAbs)}`);
    }
    const rel = relPosix(pluginRoot, file.targetAbs);
    if (backupId && !backupFile(pluginRoot, backupId, rel)) created.push(rel);
    ensureDir(dirname(file.targetAbs));
    writeAtomic(file.targetAbs, file.verdict.content);
    written.push(rel);
  }
  return { written, created };
}

export function makeId() {
  return `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${process.pid}`;
}

export function appendLog(pluginRoot, entry) {
  const jsonl = join(pluginRoot, ...LOG_JSONL.split('/'));
  ensureDir(dirname(jsonl));
  appendFileSync(jsonl, `${JSON.stringify(entry)}\n`, 'utf8');

  const md = join(pluginRoot, ...LOG_MD.split('/'));
  const head = existsSync(md) ? readText(md) : '# 回灌日志\n';
  const lines = [
    '',
    `## ${entry.at} · ${entry.units.join('、')}`,
    '',
    `- 模式：${entry.mode}`,
    `- 项目：${entry.project}`,
    `- 文件：${entry.files.length ? entry.files.join('、') : '（无）'}`,
    entry.oldVersion
      ? `- 插件版本：${entry.oldVersion} → ${entry.newVersion}`
      : (entry.mode === 'upstream' || entry.mode === 'remote'
        ? '- 插件版本：未变更'
        : '- 模板库版本：不适用（个人库与团队库没有版本文件）'),
    `- 记录 ID：\`${entry.id}\``,
    '',
  ].join('\n');
  writeAtomic(md, head.endsWith('\n') ? `${head}${lines}` : `${head}\n${lines}`);
}

export function readLog(pluginRoot) {
  const jsonl = join(pluginRoot, ...LOG_JSONL.split('/'));
  if (!existsSync(jsonl)) return [];
  return normalizeEol(readText(jsonl)).split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/** 回滚还会尝试恢复版本文件，兼容早期回灌记录里包含版本备份的情况。 */
export function revertFromLog(root, id, { restoreVersionFiles = true } = {}) {
  const entry = readLog(root).find((e) => e.id === id);
  if (!entry) throw new Error(`找不到回灌记录：${id}`);
  const restore = (rel) => {
    const bak = join(root, ...BACKUP_ROOT.split('/'), id, ...rel.split('/'));
    const target = join(root, ...rel.split('/'));
    if (existsSync(bak)) {
      ensureDir(dirname(target));
      copyFileSync(bak, target);
      return true;
    }
    if ((entry.created || []).includes(rel) && existsSync(target)) {
      rmSync(target, { force: true });
      return true;
    }
    return false;
  };
  for (const rel of entry.files || []) restore(rel);
  if (restoreVersionFiles) {
    for (const rel of ['.claude-plugin/plugin.json', 'package.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md']) {
      restore(rel);
    }
  }
  return entry;
}

/** 提交前校验：SKILL.md frontmatter 与写出的文件是否仍含疑似凭据。 */
export function validateWrittenFiles(pluginRoot, rels) {
  const errors = [];
  for (const rel of rels) {
    const abs = join(pluginRoot, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    const text = readText(abs);
    const secret = scanLine(text.replace(/\n/g, ' '), {});
    if (secret.includes('疑似密钥或凭据')) errors.push(`${rel} 仍含疑似密钥或凭据`);
    if (basename(abs) !== 'SKILL.md') continue;
    const front = parseFrontmatter(text);
    const dir = basename(dirname(abs));
    if (!front.name) errors.push(`${rel} 缺少 frontmatter name`);
    else if (front.name !== dir) errors.push(`${rel} 的 name "${front.name}" 与目录 "${dir}" 不一致`);
    if (!front.description) errors.push(`${rel} 缺少 frontmatter description`);
  }
  return errors;
}

/** 三方合并：git merge-file 返回 0 表示无冲突，1 表示有冲突。 */
export function mergeTexts(baseText, localText, templateText) {
  const dir = mkdtempSync(join(tmpdir(), 'devflow-merge-'));
  const base = join(dir, 'base');
  const local = join(dir, 'local');
  const template = join(dir, 'template');
  try {
    writeAtomic(base, normalizeEol(baseText));
    writeAtomic(local, normalizeEol(localText));
    writeAtomic(template, normalizeEol(templateText));
    const result = spawnSync('git', ['merge-file', '-p', '--diff3', local, base, template], { encoding: 'utf8' });
    if (result.status === 0) return { ok: true, content: result.stdout };
    if (result.status === 1) return { ok: false, conflicts: true, content: result.stdout };
    return { ok: false, conflicts: false, error: (result.stderr || result.stdout || '').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
