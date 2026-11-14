import { COMMANDS } from './cli-commands.mjs';

/** Claude Code 里的常用入口。保持短小稳定；完整命令列表始终来自 COMMANDS。 */
export const SCENARIOS = [
  ['新项目', '/devflow:init'],
  ['小功能', '/devflow:req --light'],
  ['小 bug', '/devflow:debug'],
  ['不确定进度', '/devflow:status'],
  ['熟悉项目', '/devflow:onboard'],
  ['体检', '/devflow:doctor'],
];

const EXAMPLES = [
  'devflow init',
  'devflow status --slug add-login --ack',
  'devflow stack add java-spring --repo <url>',
  'devflow upstream --stack java-spring --to personal --apply',
  'devflow change --slug add-login --list',
  'devflow help change',
];

/** 参数较多或带子命令的命令，在单命令帮助里补几条示例；总帮助只保留通用的几条。 */
const COMMAND_EXAMPLES = {
  stack: [
    'devflow stack add java-spring --repo <url>',
    'devflow stack list',
    'devflow stack update --all',
    'devflow stack restore',
    'devflow stack status --json',
    'devflow stack remove java-spring --keep',
  ],
};

const HELP_DESC = '显示本帮助或单个命令的用法';

export function isCommand(name) {
  return typeof name === 'string' && Object.hasOwn(COMMANDS, name);
}

function commandRows() {
  const names = [...Object.keys(COMMANDS), 'help'];
  const width = Math.max(...names.map((name) => name.length));
  return names.map((name) => {
    const desc = name === 'help' ? HELP_DESC : COMMANDS[name][1];
    return `  ${name.padEnd(width)}  ${desc}`;
  }).join('\n');
}

export function renderHelp() {
  return [
    'devflow — Claude Code 六阶段工程工作流',
    '',
    '按场景选入口：',
    ...SCENARIOS.map(([label, entry]) => `  ${label} → ${entry}`),
    '',
    '命令：',
    commandRows(),
    '',
    '查看单个命令用法：',
    '  devflow help <命令>',
    '  devflow <命令> --help',
    '',
    '示例：',
    ...EXAMPLES.map((line) => `  ${line}`),
    '',
    '插件文档：README.md、docs/quickstart.md、docs/usage.md（位于插件安装目录）',
  ].join('\n');
}

export function renderCommandHelp(name) {
  if (name === 'help') {
    return [
      `devflow help — ${HELP_DESC}`,
      '',
      '用法：',
      '  devflow help',
      '  devflow help <命令>',
    ].join('\n');
  }
  if (!isCommand(name)) throw new Error('未知命令');
  const [, desc, usage] = COMMANDS[name];
  const examples = COMMAND_EXAMPLES[name] || [];
  return [
    `devflow ${name} — ${desc}`,
    '',
    '用法：',
    `  devflow ${name}${usage ? ` ${usage}` : ''}`,
    ...(examples.length ? ['', '示例：', ...examples.map((line) => `  ${line}`)] : []),
    '',
    '详细参数与示例见插件安装目录下的 docs/usage.md。',
  ].join('\n');
}
