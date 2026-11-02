#!/usr/bin/env node
// UserPromptSubmit：在用户下一次输入时提醒尚未验证的改动；只注入一次，从不阻止。
import { existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, findHubRoot, updateState } from './lib.mjs';

await readStdin();
let message = '';
try {
  const root = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  if (!existsSync(stateFile)) process.exit(0);

  updateState(stateFile, (state) => {
    if (!state.testsPending) return state;

    const lastChange = Date.parse(state.lastChangeAt || '');
    const lastTest = Date.parse(state.lastTestPassedAt || '');
    const lastReminder = Date.parse(state.lastPromptReminderAt || '');
    const tested = !Number.isNaN(lastTest) && (Number.isNaN(lastChange) || lastTest >= lastChange);
    const reminded = !Number.isNaN(lastReminder) && (Number.isNaN(lastChange) || lastReminder >= lastChange);
    if (tested) {
      state.testsPending = false;
      return state;
    }
    if (reminded) return state;

    const files = (state.changedFiles || []).slice(-5);
    message = 'devflow 提醒：上一轮有代码改动尚未验证通过。继续推进前先运行 /devflow:test 并记录真实结果。'
      + (files.length ? `改动文件：${files.join('、')}` : '');
    state.lastPromptReminderAt = new Date().toISOString();
    return state;
  });
} catch {
  // 提醒失败不能影响用户提交 prompt。
}
if (message) {
  try {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: message,
      },
    }));
  } catch {
    // 写输出失败同样放行，不影响用户提交 prompt。
  }
}
process.exit(0);
