#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit)：记录改动文件，标记测试待验证。
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function findRoot(start) {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.claude', 'hub', 'hub.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const raw = await readStdin();
let payload = {};
try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

try {
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const file = payload.tool_input?.file_path || payload.tool_input?.path;
  if (!file) process.exit(0);

  let rel = file;
  if (isAbsolute(file)) rel = relative(root, file).split('\\').join('/');
  if (rel.startsWith('..')) process.exit(0);
  if (rel.startsWith('.claude/skills/devflow-')) process.exit(0);
  if (rel === '.claude/.devflow-state.json') process.exit(0);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  let state = {};
  if (existsSync(stateFile)) {
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  }
  const files = Array.isArray(state.changedFiles) ? state.changedFiles : [];
  if (!files.includes(rel)) files.push(rel);
  state.changedFiles = files.slice(-200);
  state.lastChangeAt = new Date().toISOString();
  state.testsPending = true;

  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, stateFile);
} catch {
  // 记录失败不应影响文件编辑本身。
}
process.exit(0);
