#!/usr/bin/env node
// Stop：仅提醒，从不阻止。测试未跑或改动晚于测试时提示；阶段源改动未生成时提示 gen/doctor。
// 同一批改动只提醒一次；测试提醒与 hub 提醒可以同时出现。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, findHubRoot, writeJsonAtomic } from './lib.mjs';

await readStdin();
try {
  const root = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  if (!existsSync(stateFile)) process.exit(0);

  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { process.exit(0); }

  const messages = [];
  const now = new Date().toISOString();

  // 测试提醒：解析失败必须按“未知”处理，不能落成 1999 年造成误判。
  if (state.testsPending) {
    const lastChange = Date.parse(state.lastChangeAt || '');
    const lastTest = Date.parse(state.lastTestPassedAt || '');
    const lastReminder = Date.parse(state.lastReminderAt || '');
    const tested = !Number.isNaN(lastTest) && (Number.isNaN(lastChange) || lastTest >= lastChange);
    const reminded = !Number.isNaN(lastReminder) && (Number.isNaN(lastChange) || lastReminder >= lastChange);
    if (!tested && !reminded) {
      const files = (state.changedFiles || []).slice(-8);
      messages.push(`devflow 提醒：本轮改动尚未验证通过。可运行 /devflow:test 记录结果。`
        + (files.length ? `\n改动文件：${files.join('、')}` : ''));
      state.lastReminderAt = now;
    }
  }

  // hub 提醒：账本时间晚于最近一次 hub 改动，说明投影已生成，不再提示。
  if (state.hubPending) {
    const lastHubChange = Date.parse(state.lastHubChangeAt || '');
    const lastHubReminder = Date.parse(state.lastHubReminderAt || '');
    const manifestFile = join(root, '.claude', '.hub-manifest.json');
    let generated = false;
    if (existsSync(manifestFile) && !Number.isNaN(lastHubChange)) {
      try { generated = statSync(manifestFile).mtimeMs >= lastHubChange; } catch { generated = false; }
    }
    const reminded = !Number.isNaN(lastHubReminder) && (Number.isNaN(lastHubChange) || lastHubReminder >= lastHubChange);
    if (!generated && !reminded) {
      const files = (state.hubChangedFiles || []).slice(-8);
      messages.push('devflow 提醒：阶段源（.claude/hub/）有改动，但投影尚未生成。'
        + '请运行 node scripts/devflow-gen.mjs，再用 node scripts/devflow-doctor.mjs 检查。'
        + (files.length ? `\n改动文件：${files.join('、')}` : ''));
      state.lastHubReminderAt = now;
    }
  }

  if (!messages.length) process.exit(0);
  try {
    writeJsonAtomic(stateFile, state);
  } catch { /* 写失败不影响提醒 */ }

  process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n\n') }));
} catch {
  // 提醒失败不应影响会话结束。
}
process.exit(0);
