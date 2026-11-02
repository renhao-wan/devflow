#!/usr/bin/env node
// SubagentStop：devflow 子代理结束时提示主上下文核对结论；只提醒，不阻止。
import { writeSync } from 'node:fs';
import { readStdin } from './lib.mjs';

const { text, complete } = await readStdin();
if (!complete) process.exit(0);

let input = {};
try {
  input = JSON.parse(text);
} catch {
  process.exit(0);
}

const type = String(input.agent_type || input.subagent_type || input.agent_name || '');
const messages = {
  'devflow-test-runner': 'devflow：测试子代理已结束。请核对真实命令、退出码与 test.md，不要把子代理摘要直接当作测试通过证据。',
  'devflow-code-reviewer': 'devflow：审查子代理已结束。请把结论落回 review.md，并用自己的代码与测试证据核实阻断项。',
  'devflow-debug-investigator': 'devflow：排障子代理已结束。结论仍需本地复现确认，不要把未经复现的假设写成根因。',
};

for (const [name, message] of Object.entries(messages)) {
  if (type.includes(name)) {
    try {
      writeSync(1, JSON.stringify({ systemMessage: message }));
    } catch {
      // 提醒失败不能阻止子代理结束流程。
    }
    break;
  }
}
process.exit(0);
