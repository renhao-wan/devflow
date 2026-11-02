#!/usr/bin/env node
// PostToolUse(Agent/Task)：devflow 子代理结束时向主上下文注入核对提醒；只提醒，不阻止。
// 兼容旧版手动配置的 SubagentStop 载荷：此时只返回 systemMessage。
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

const tool = String(input.tool_name || input.toolName || '');
if (tool && tool !== 'Agent' && tool !== 'Task') process.exit(0);

let toolInput = input.tool_input;
if (typeof toolInput === 'string') {
  try {
    toolInput = JSON.parse(toolInput);
  } catch {
    toolInput = {};
  }
}

const type = String(
  toolInput?.subagent_type
  || toolInput?.agent_type
  || toolInput?.agent_name
  || input.agent_type
  || input.subagent_type
  || input.agent_name
  || '',
);
const messages = {
  'devflow-test-runner': 'devflow：测试子代理已结束。请核对真实命令、退出码与 test.md，不要把子代理摘要直接当作测试通过证据。',
  'devflow-code-reviewer': 'devflow：审查子代理已结束。请把结论落回 review.md，并用自己的代码与测试证据核实阻断项。',
  'devflow-debug-investigator': 'devflow：排障子代理已结束。结论仍需本地复现确认，不要把未经复现的假设写成根因。',
};

for (const [name, message] of Object.entries(messages)) {
  if (!type.includes(name)) continue;
  try {
    const payload = tool
      ? {
          systemMessage: message,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: message,
          },
        }
      : { systemMessage: message };
    writeSync(1, JSON.stringify(payload));
  } catch {
    // 提醒失败不能阻止子代理结束流程。
  }
  break;
}
process.exit(0);
