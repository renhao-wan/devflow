#!/usr/bin/env node
// PreToolUse(Bash|PowerShell|Monitor)：危险命令硬门禁。deny 直接阻止，ask 交给用户确认。
// 只在命令位置匹配命令类规则，引号内文本不参与匹配；嵌套 shell、xargs、find -exec 会递归检查。
import { writeSync } from 'node:fs';
import { readStdin } from './lib.mjs';

const DENY = [
  { re: /\bdd\b[^|;]*\bof=\/dev\/(sd|hd|nvme|disk)/, why: '直接写裸设备' },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork 炸弹' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/, why: '对根目录递归放开权限' },
  { re: /\bcurl\b[^|;]*\|\s*(sudo\s+)?(sh|bash)\b/, why: '下载内容直接执行' },
  { re: /\bwget\b[^|;]*\|\s*(sudo\s+)?(sh|bash)\b/, why: '下载内容直接执行' },
  { re: />\s*\/dev\/(sd|hd|nvme)/, why: '重定向覆盖裸设备' },
];

const ASK = [
  { re: /\bnpm\s+publish\b/, why: '发布包到 registry' },
  { re: /\bdocker\s+(rm|rmi)\s+-f\b/, why: '强制删除容器或镜像' },
  { re: /\bdocker\s+system\s+prune\b/, why: '清理 Docker 资源' },
  { re: /\b(kubectl\s+delete|helm\s+uninstall)\b/, why: '删除集群资源' },
  { re: /\bmigrate\b[^|;]*\b(down|reset|rollback)\b/i, why: '回滚数据库迁移' },
];

// SQL 规则只作用于 SQL 客户端通过 -c/-e 传入的语句，避免 echo/grep 文档里的同名文本误伤。
const DENY_SQL = [
  { re: /\bDROP\s+(DATABASE|SCHEMA)\b/i, why: '删除数据库结构' },
  { re: /\bTRUNCATE\s+TABLE\b/i, why: '清空数据表' },
];
const ASK_SQL = [
  { re: /\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/i, why: '删除数据库列' },
];

const DB_CLIENTS = new Set([
  'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd',
  'mongosh', 'mongo', 'cockroach', 'mysqlsh', 'clickhouse-client',
]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell']);
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'time', 'nohup', 'nice', 'builtin', 'exec', 'env']);
const HALT_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'restart-computer', 'stop-computer']);
const DISK_COMMANDS = new Set([
  'fdisk', 'parted', 'diskpart', 'format', 'cipher', 'vssadmin',
  'format-volume', 'clear-disk', 'initialize-disk',
]);
const MAX_DEPTH = 4;

/** 把引号内文本替换为空格，保留引号与位置，避免提交信息、grep 关键词被当成命令。 */
function maskQuoted(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < text.length) {
        if (quote === '"' && text[i] === '\\' && i + 1 < text.length) {
          out += '  ';
          i += 2;
          continue;
        }
        const c = text[i];
        out += c === quote ? quote : ' ';
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 引号感知的轻量分词：返回 word（保留引号内内容）与操作符，用于定位命令位置。 */
function tokenize(input) {
  const tokens = [];
  let cur = '';
  let started = false;
  let quoted = false;
  let mode = 'plain';
  const endWord = () => {
    if (started) tokens.push({ value: cur, quoted });
    cur = '';
    started = false;
    quoted = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (mode === 'single') {
      if (ch === "'") { mode = 'plain'; quoted = true; } else cur += ch;
      started = true;
      continue;
    }
    if (mode === 'double') {
      if (ch === '\\' && i + 1 < input.length && ['"', '\\', '$', '`'].includes(input[i + 1])) {
        cur += input[i + 1];
        i += 1;
      } else if (ch === '"') {
        mode = 'plain';
        quoted = true;
      } else {
        cur += ch;
      }
      started = true;
      continue;
    }
    if (ch === "'") { mode = 'single'; started = true; quoted = true; continue; }
    if (ch === '"') { mode = 'double'; started = true; quoted = true; continue; }
    // 反斜杠续行：\\\n / \\\r\n 不是命令分隔符，先整体跳过。
    if (ch === '\\' && (input[i + 1] === '\n' || input[i + 1] === '\r')) {
      i += 1;
      if (input[i] === '\r' && input[i + 1] === '\n') i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1];
      i += 1;
      started = true;
      continue;
    }
    // 换行必须先生成命令分隔符，不能作为普通空白吞掉。
    if (ch === '\n' || ch === '\r') { endWord(); tokens.push({ op: ';' }); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    if ((ch === '&' && input[i + 1] === '&') || (ch === '|' && input[i + 1] === '|')) {
      endWord();
      tokens.push({ op: ch + ch });
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '>' || ch === '<') {
      endWord();
      tokens.push({ op: ch });
      continue;
    }
    cur += ch;
    started = true;
  }
  endWord();
  return tokens;
}

function simpleCommands(tokens) {
  const groups = [];
  let cur = [];
  for (const token of tokens) {
    if (token.op) {
      if (cur.length) groups.push(cur);
      cur = [];
    } else {
      cur.push(token);
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function baseName(value) {
  const s = String(value || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s).replace(/^["']|["']$/g, '');
}

/** 统一命令名：去目录、去 .exe、转小写，避免 shutdown.exe / CMD.EXE 之类的变体绕过。 */
function normalizeCmd(value) {
  return baseName(value).replace(/\.exe$/i, '').toLowerCase();
}

const WRAPPER_VALUES = {
  sudo: new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-h', '--host',
    '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user',
    '-T', '--command-timeout']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  exec: new Set(['-a']),
};

/** 跳过命令前的选项及其参数（如 sudo -u root、nice -n 10）。 */
function skipOptions(tokens, start, withValue = null) {
  let i = start;
  while (i < tokens.length) {
    const value = tokens[i].value;
    if (value === '--') { i += 1; break; }
    if (value === '-' || !value.startsWith('-')) break;
    const opt = value.split('=')[0];
    i += 1;
    if (!value.includes('=') && withValue?.has(opt)) i += 1;
  }
  return i;
}

function stripWrappers(tokens) {
  let i = 0;
  while (i < tokens.length) {
    // 环境变量前缀也属于包装：FOO=1 rm -rf /
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) { i += 1; continue; }
    const name = normalizeCmd(tokens[i].value);
    if (name === 'timeout') {
      i = skipOptions(tokens, i + 1, WRAPPER_VALUES.timeout);
      // 跳过一个 duration 参数，后面才是真正要执行的命令
      if (i < tokens.length) i += 1;
      continue;
    }
    if (WRAPPERS.has(name)) {
      i = skipOptions(tokens, i + 1, WRAPPER_VALUES[name] || null);
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

const ROOTISH = /^(?:\/|~|\$HOME|\.{1,2})\/?$/;
const BROAD_TARGET = /^(?:\/|\.{1,2}\/)?\*+$/;
const DRIVE_ROOT = /^[a-zA-Z]:\\?\*?$/;

function rmDecision(args) {
  let recursive = false;
  let force = false;
  const targets = [];
  for (const token of args) {
    const value = token.value;
    if (value === '--') continue;
    if (value.startsWith('--')) {
      if (value.startsWith('--recursive')) recursive = true;
      if (value.startsWith('--force')) force = true;
      continue;
    }
    if (value.startsWith('-') && value.length > 1) {
      if (/[rR]/.test(value)) recursive = true;
      if (value.includes('f')) force = true;
      continue;
    }
    targets.push(value);
  }
  if (recursive && targets.some((t) => ROOTISH.test(t) || DRIVE_ROOT.test(t))) {
    return [{ decision: 'deny', why: '递归删除根目录或当前目录' }];
  }
  if (recursive && force && targets.some((t) => BROAD_TARGET.test(t))) {
    return [{ decision: 'deny', why: '递归强制删除通配符' }];
  }
  if (recursive && force) return [{ decision: 'ask', why: '递归强制删除' }];
  if (force && targets.length === 0) return [{ decision: 'ask', why: '强制删除（未指定目标）' }];
  return [];
}

const WIN_ROOT = /^[a-zA-Z]:\\?\*?$/i;
const RECURSE_SWITCH = /^\/[a-z/]*s[a-z/]*$/i;
const RECURSE_PARAM = /^-(?:r[a-z]*|recurse)$/i;

/** Windows 的 rd/del/Remove-Item 递归删除不在全局正则里逐条覆盖，按命令位置判断。 */
function winDeleteDecision(cmd, args) {
  const name = normalizeCmd(cmd);
  const values = args.map((t) => t.value);
  const hasSwitch = (re) => values.some((v) => re.test(v));
  const target = values.find((v) => !v.startsWith('/') && !v.startsWith('-'));
  if (name === 'rd' || name === 'rmdir' || name === 'del' || name === 'erase') {
    // rd /s/q 这类合并开关也要识别
    if (!hasSwitch(RECURSE_SWITCH)) return [];
    if (target && WIN_ROOT.test(target)) return [{ decision: 'deny', why: '递归删除盘符根' }];
    return [{ decision: 'ask', why: '递归删除文件或目录，可能丢数据' }];
  }
  if (name === 'remove-item' || name === 'ri') {
    // PowerShell 允许 -Rec、-Recurse 等前缀缩写
    if (!hasSwitch(RECURSE_PARAM)) return [];
    if (target && WIN_ROOT.test(target)) return [{ decision: 'deny', why: '递归删除盘符根' }];
    return [{ decision: 'ask', why: '递归删除文件或目录，可能丢数据' }];
  }
  return [];
}

/** 磁盘级破坏按命令位置判断，避免 `man mkfs`、`Get-Help Format-Volume` 被误拦。 */
function diskDecision(cmd, args) {
  const values = args.map((t) => t.value);
  const lower = values.map((v) => v.toLowerCase());
  if (cmd.startsWith('mkfs')) return [{ decision: 'deny', why: '格式化或分区磁盘' }];
  if (cmd === 'fdisk' || cmd === 'parted') return [{ decision: 'deny', why: '格式化或分区磁盘' }];
  if (cmd === 'diskpart') return [{ decision: 'deny', why: '磁盘分区操作' }];
  if (cmd === 'format' && values.some((v) => /^[a-zA-Z]:/.test(v))) {
    return [{ decision: 'deny', why: '格式化磁盘' }];
  }
  if (cmd === 'cipher' && values.some((v) => /^\/w/i.test(v))) {
    return [{ decision: 'deny', why: '擦除磁盘空闲空间' }];
  }
  if (cmd === 'vssadmin' && lower.includes('delete') && lower.includes('shadows')) {
    return [{ decision: 'deny', why: '删除卷影副本' }];
  }
  if (cmd === 'format-volume' || cmd === 'clear-disk' || cmd === 'initialize-disk') {
    return [{ decision: 'deny', why: '格式化或初始化磁盘' }];
  }
  return [];
}

function ddDecision(args) {
  if (args.some((t) => /^of=\/dev\/(sd|hd|nvme|disk)/i.test(t.value))) {
    return [{ decision: 'deny', why: '直接写裸设备' }];
  }
  return [];
}

const GIT_GLOBAL_VALUE = new Set([
  '-C', '--git-dir', '--work-tree', '-c', '--namespace', '--exec-path', '--config-env', '--super-prefix',
]);

function isProtectedRef(value) {
  const clean = String(value).replace(/^\+/, '').split(':').pop();
  return /(^|\/)(main|master)$/.test(clean) || /^release\//.test(clean);
}

function gitPushDecision(args) {
  let force = false;
  let del = false;
  let mirror = false;
  const refs = [];
  for (const value of args) {
    if (value === '-f' || value === '--force' || /^--force-with-lease(?:=.*)?$/.test(value)) force = true;
    else if (value === '--mirror') mirror = true;
    else if (value === '--delete' || value === '-d') del = true;
    else if (value.startsWith('-')) continue;
    else refs.push(value);
  }
  const plus = refs.some((r) => r.startsWith('+'));
  const deleteRefspec = refs.some((r) => r.startsWith(':') && r.length > 1);
  const protectedRef = refs.some(isProtectedRef);
  if ((force || plus) && protectedRef) return [{ decision: 'deny', why: '强推受保护分支' }];
  if ((del || deleteRefspec) && protectedRef) return [{ decision: 'deny', why: '删除远端受保护分支' }];
  if (force && refs.length === 0) return [{ decision: 'deny', why: '强推（未指定分支）' }];
  const findings = [];
  if (force || plus) findings.push({ decision: 'ask', why: '强推，可能覆盖远端历史' });
  if (del || deleteRefspec) findings.push({ decision: 'ask', why: '删除远端分支或引用' });
  if (mirror) findings.push({ decision: 'ask', why: '镜像推送，可能覆盖远端所有引用' });
  return findings;
}

/** 解析 git 全局选项后按子命令判断；支持 `git -C <dir> ...` 与引号命令名。 */
function gitDecision(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const value = tokens[i].value;
    if (value === '--') { i += 1; break; }
    if (!value.startsWith('-')) break;
    if (value.includes('=')) { i += 1; continue; }
    i += GIT_GLOBAL_VALUE.has(value) ? 2 : 1;
  }
  const sub = String(tokens[i]?.value || '').toLowerCase();
  if (!sub) return [];
  const args = tokens.slice(i + 1).map((t) => t.value);
  if (sub === 'push') return gitPushDecision(args);
  if (sub === 'reset' && args.some((a) => a === '--hard' || a === '--mixed')) {
    return [{ decision: 'ask', why: '重置提交，可能丢失改动' }];
  }
  if (sub === 'clean' && args.some((a) => a === '--force' || /^-[a-zA-Z]*[fdx]/.test(a))) {
    return [{ decision: 'ask', why: '删除未跟踪文件' }];
  }
  if ((sub === 'checkout' || sub === 'restore') && args.includes('.')) {
    return [{ decision: 'ask', why: '丢弃所有本地改动' }];
  }
  if (sub === 'branch' && args.some((a) => a === '--delete' || /^-[a-zA-Z]*[dD]/.test(a))) {
    return [{ decision: 'ask', why: '删除本地分支' }];
  }
  if (sub === 'update-ref' && args.includes('-d')) {
    return [{ decision: 'ask', why: '删除 Git 引用' }];
  }
  if (sub === 'filter-branch') return [{ decision: 'ask', why: '重写 Git 历史' }];
  if (sub === 'reflog' && args.includes('expire')) {
    return [{ decision: 'ask', why: '清空 reflog，丢失恢复线索' }];
  }
  return [];
}

const XARGS_VALUE_OPTS = new Set([
  '-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '-e',
  '--max-args', '--max-lines', '--max-procs', '--replace', '--delimiter',
  '--eof', '--max-chars', '--arg-file',
]);

/** 返回 xargs 实际执行命令在 args 中的下标；找不到时返回 -1。 */
function xargsTargetIndex(args) {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i].value;
    if (value === '--') return i + 1 < args.length ? i + 1 : -1;
    if (value.startsWith('-') && value !== '-') {
      const opt = value.split('=')[0];
      if (!value.includes('=') && XARGS_VALUE_OPTS.has(opt)) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

function xargsDecision(args) {
  const index = xargsTargetIndex(args);
  if (index >= 0 && normalizeCmd(args[index].value) === 'rm') {
    return [{ decision: 'ask', why: 'xargs 调用 rm，删除目标由输入决定' }];
  }
  return [];
}

function findExecIndex(args) {
  return args.findIndex((t) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t.value));
}

function findDecision(args) {
  const i = findExecIndex(args);
  if (i >= 0 && args[i + 1] && normalizeCmd(args[i + 1].value) === 'rm') {
    return [{ decision: 'ask', why: 'find -exec 调用 rm' }];
  }
  return [];
}

function commandAfter(tokens, i) {
  const rest = tokens.slice(i + 1);
  if (!rest.length) return null;
  // 单个 token 可能是整段带引号的脚本，原样返回；多个 token 说明是未加引号的命令，拼回去再递归检查。
  return rest.length === 1 ? rest[0].value : rest.map((t) => t.value).join(' ');
}

function nestedCommand(tokens) {
  const cmd = normalizeCmd(tokens[0].value);
  if (SHELLS.has(cmd)) {
    for (let i = 1; i < tokens.length; i += 1) {
      const value = tokens[i].value;
      // bash -lc、pwsh -NoProfile -Command、sh -ec 等所有含 c 的短选项
      if (/^-[A-Za-z]*c[A-Za-z]*$/i.test(value) || /^--command$/i.test(value) || /^\/[ck]$/i.test(value)) {
        return commandAfter(tokens, i);
      }
    }
    return null;
  }
  if (cmd === 'cmd') {
    const i = tokens.findIndex((t, idx) => idx > 0 && /^\/\/?[ck]$/i.test(t.value));
    return i >= 0 ? commandAfter(tokens, i) : null;
  }
  if (cmd === 'eval') return tokens.slice(1).map((t) => t.value).join(' ');
  return null;
}

function sqlTexts(command) {
  const texts = [];
  for (const raw of simpleCommands(tokenize(command))) {
    const group = stripWrappers(raw);
    if (!group.length || !DB_CLIENTS.has(normalizeCmd(group[0].value))) continue;
    for (let i = 1; i < group.length; i += 1) {
      if (['-c', '-e', '-Q', '-q', '--command', '--execute', '-Command'].includes(group[i].value) && group[i + 1]) {
        texts.push(group[i + 1].value);
      }
    }
  }
  return texts;
}

function evaluate(command, depth = 0) {
  const findings = [];
  if (depth > MAX_DEPTH) return findings;

  for (const raw of simpleCommands(tokenize(command))) {
    const group = stripWrappers(raw);
    if (!group.length) continue;
    const cmd = normalizeCmd(group[0].value);
    const runNested = (sub) => {
      const inner = nestedCommand(sub);
      if (inner) findings.push(...evaluate(inner, depth + 1));
    };
    if (HALT_COMMANDS.has(cmd)) findings.push({ decision: 'deny', why: '关机或重启机器' });
    else if (cmd === 'systemctl' && group.slice(1).some((t) => /^(reboot|poweroff|halt)$/i.test(t.value))) {
      findings.push({ decision: 'deny', why: '关机或重启机器' });
    } else if (cmd === 'rm') {
      findings.push(...rmDecision(group.slice(1)));
    } else if (['rd', 'rmdir', 'del', 'erase', 'remove-item', 'ri'].includes(cmd)) {
      findings.push(...winDeleteDecision(cmd, group.slice(1)));
    } else if (cmd === 'xargs') {
      const rest = group.slice(1);
      findings.push(...xargsDecision(rest));
      const index = xargsTargetIndex(rest);
      // xargs -I{} bash -c "..." 这类会把危险命令藏在嵌套 shell 里
      if (index >= 0) runNested(rest.slice(index));
    } else if (cmd === 'find') {
      const rest = group.slice(1);
      findings.push(...findDecision(rest));
      const index = findExecIndex(rest);
      // find -exec sh -c "..." 同上
      if (index >= 0) runNested(rest.slice(index + 1));
    } else if (cmd === 'git') {
      findings.push(...gitDecision(group));
    } else if (cmd === 'dd') {
      findings.push(...ddDecision(group.slice(1)));
    } else if (DISK_COMMANDS.has(cmd) || cmd.startsWith('mkfs')) {
      findings.push(...diskDecision(cmd, group.slice(1)));
    }
    const inner = nestedCommand(group);
    if (inner) findings.push(...evaluate(inner, depth + 1));
  }

  const masked = maskQuoted(command);
  for (const rule of DENY) if (rule.re.test(masked)) findings.push({ decision: 'deny', why: rule.why });
  for (const rule of ASK) if (rule.re.test(masked)) findings.push({ decision: 'ask', why: rule.why });
  for (const sql of sqlTexts(command)) {
    const maskedSql = maskQuoted(sql);
    for (const rule of DENY_SQL) if (rule.re.test(maskedSql)) findings.push({ decision: 'deny', why: rule.why });
    for (const rule of ASK_SQL) if (rule.re.test(maskedSql)) findings.push({ decision: 'ask', why: rule.why });
  }
  return findings;
}

function decide(command) {
  const findings = evaluate(command);
  return findings.find((f) => f.decision === 'deny')
    || findings.find((f) => f.decision === 'ask')
    || null;
}

/** 回显命令前脱敏：URL 凭据、环境变量赋值、常见 token 参数与 Authorization 头。 */
function redact(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1$2:***@')
    .replace(/(\b[A-Za-z_][A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/([?&](?:token|access_token|api[_-]?key|key|secret|password|passwd|pwd)=)[^&\s]+/gi, '$1***')
    .replace(/(\bAuthorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/(--?(?:token|api-key|apikey|secret|password|passwd|pwd|client-secret)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/gi, '$1***');
}

function emit(decision, reason) {
  // 单次 writeSync 保证进程退出前 stdout 已刷新，避免 decision 丢失。
  writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

try {
  const { text: raw, complete } = await readStdin();
  // 输入被截断时无法可靠判断，交给用户确认，而不是静默放行半截命令。
  if (!complete) {
    emit('ask', 'devflow 安全门禁：命令输入未完整读取，无法可靠检查，请确认后再执行。');
    process.exit(0);
  }
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  if (!['Bash', 'PowerShell', 'Monitor'].includes(payload.tool_name)) process.exit(0);
  const command = payload.tool_input?.command ?? payload.tool_input?.cmd;
  if (typeof command !== 'string' || !command.trim()) process.exit(0);

  const hit = decide(command);
  if (hit) {
    const prefix = hit.decision === 'deny' ? 'devflow 安全门禁：' : 'devflow 提醒：';
    const shown = redact(command).slice(0, 200);
    emit(hit.decision, `${prefix}${hit.why}${hit.decision === 'ask' ? '，请确认后再执行' : ''}。命令：${shown}`);
  }
} catch {
  // 钩子自身异常时放行，避免把正常命令挡死。
}
process.exit(0);
