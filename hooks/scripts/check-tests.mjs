#!/usr/bin/env node
// Stop：仅提醒，从不阻止。测试未跑或改动晚于测试时提示；同一批改动只提醒一次。
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
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

  // 解析失败必须按“未知”处理，不能落成 1999 年造成误判。
  const lastChange = Date.parse(state.lastChangeAt || '');
  const lastTest = Date.parse(state.lastTestPassedAt || '');
  if (!Number.isNaN(lastTest) && (Number.isNaN(lastChange) || lastTest >= lastChange)) process.exit(0);

  // 同一批改动已提醒过就不再重复，避免每次 Stop 都刷屏
  const lastReminder = Date.parse(state.lastReminderAt || '');
  if (!Number.isNaN(lastReminder) && (Number.isNaN(lastChange) || lastReminder >= lastChange)) process.exit(0);

  state.lastReminderAt = new Date().toISOString();
  try {
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, stateFile);
  } catch { /* 写失败不影响提醒 */ }

  const files = (state.changedFiles || []).slice(-8);
  const msg = `devflow 提醒：本轮改动尚未验证通过。可运行 /devflow:test 记录结果。` +
    (files.length ? `\n改动文件：${files.join('、')}` : '');

  process.stdout.write(JSON.stringify({ systemMessage: msg }));
} catch {
  // 提醒失败不应影响会话结束。
}
process.exit(0);
