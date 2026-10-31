#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit|NotebookEdit|Bash)：记录改动文件，标记测试待验证。
// Bash 可能通过 sed -i、格式化器、代码生成等间接改文件，用 git status 兜底发现。
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStdin, findHubRoot } from './lib.mjs';

const LEDGERS = new Set([
  '.claude/.devflow-state.json',
  '.claude/.hub-manifest.json',
  '.claude/.hub-sources.json',
  '.devflow.json',
]);

// 构建产物与依赖目录不视为业务改动，避免生成/安装后反复把测试标记为待验证。
const NOISE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
  'target', 'out', 'vendor', '.cache',
]);

function isNoise(rel) {
  if (rel.startsWith('.claude/skills/devflow-')) return true;
  if (LEDGERS.has(rel)) return true;
  const segments = rel.split('/');
  if (segments.some((s) => NOISE_DIRS.has(s))) return true;
  if (segments.some((s) => /\.bak(-|$)/i.test(s) || /\.tmp(-|$)/i.test(s))) return true;
  return false;
}

function gitChanged(root) {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '-uall'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  const entries = (result.stdout || '').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    files.push(entries[i].slice(3).replace(/\\/g, '/'));
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return files;
}

const raw = await readStdin();
let payload = {};
try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

try {
  const root = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  let state = {};
  if (existsSync(stateFile)) {
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  }
  // 没有历史状态时只回看最近 2 秒，避免把打开会话前就存在的脏文件算成本次改动。
  const lastTrackAt = Date.parse(state.lastTrackAt || state.lastChangeAt || 0) || (Date.now() - 2000);

  let changed = [];
  if (payload.tool_name === 'Bash') {
    // Bash 后的 git status 会包含执行前就存在的脏文件；只保留本次命令真正改动的路径。
    changed = gitChanged(root).filter((rel) => {
      if (!rel || rel.startsWith('..') || isNoise(rel)) return false;
      // 文件被删除时自身已无 mtime，用父目录的更新时间判断本次操作。
      try { return statSync(join(root, rel)).mtimeMs > lastTrackAt; } catch {
        try { return statSync(dirname(join(root, rel))).mtimeMs > lastTrackAt; } catch { return false; }
      }
    });
  } else {
    const file = payload.tool_input?.file_path || payload.tool_input?.path;
    if (!file) process.exit(0);
    let rel = file;
    if (isAbsolute(file)) rel = relative(root, file).split('\\').join('/');
    // 跨盘符时 relative() 会返回绝对路径，必须再次判断
    if (isAbsolute(rel) || rel.startsWith('..')) process.exit(0);
    if (isNoise(rel)) process.exit(0);
    changed = [rel];
  }
  if (!changed.length) process.exit(0);

  const files = Array.isArray(state.changedFiles) ? state.changedFiles : [];
  for (const rel of changed) if (!files.includes(rel)) files.push(rel);
  state.changedFiles = files.slice(-200);
  state.lastChangeAt = new Date().toISOString();
  state.lastTrackAt = state.lastChangeAt;
  state.testsPending = true;

  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, stateFile);
} catch {
  // 记录失败不应影响文件编辑本身。
}
process.exit(0);
