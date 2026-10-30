#!/usr/bin/env node
// Stop：仅提醒，从不阻止。测试未跑或改动晚于测试时提示。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, findHubRoot } from './lib.mjs';

await readStdin();
try {
  const root = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  if (!existsSync(stateFile)) process.exit(0);

  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { process.exit(0); }
  if (!state.testsPending) process.exit(0);

  const lastChange = Date.parse(state.lastChangeAt || 0);
  const lastTest = Date.parse(state.lastTestPassedAt || 0);
  if (state.lastTestPassedAt && lastTest >= lastChange) process.exit(0);

  const files = (state.changedFiles || []).slice(-8);
  const msg = `devflow 提醒：本轮改动尚未验证通过。可运行 /devflow:test 记录结果。` +
    (files.length ? `\n改动文件：${files.join('、')}` : '');

  process.stdout.write(JSON.stringify({ systemMessage: msg }));
} catch {
  // 提醒失败不应影响会话结束。
}
process.exit(0);
