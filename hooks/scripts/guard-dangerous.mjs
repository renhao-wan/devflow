#!/usr/bin/env node
// PreToolUse(Bash)：危险命令硬门禁。deny 直接阻止，ask 交给用户确认。
// 只在命令位置匹配命令类规则，引号内文本不参与匹配；嵌套 shell、xargs、find -exec 会递归检查。
import { readStdin } from './lib.mjs';

const DENY = [
  { re: /\b(mkfs(\.\w+)?|fdisk|parted)\b/, why: '格式化或分区磁盘' },
  { re: /\bdd\b[^|;]*\bof=\/dev\/(sd|hd|nvme|disk)/, why: '直接写裸设备' },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork 炸弹' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/, why: '对根目录递归放开权限' },
  { re: /\bcurl\b[^|;]*\|\s*(sudo\s+)?(sh|bash)\b/, why: '下载内容直接执行' },
  { re: /\bwget\b[^|;]*\|\s*(sudo\s+)?(sh|bash)\b/, why: '下载内容直接执行' },
  { re: /\bgit\s+push\b[^|;]*\s(-f|--force(-with-lease)?)\b[^|;]*\b(main|master|release\/\S+)\b/, why: '强推受保护分支' },
  { re: /\bgit\s+push\b[^|;]*\s\+[^\s:]*(main|master)\b/, why: '强推受保护分支' },
  { re: /\bgit\s+push\b[^|;]*\s:(main|master)\b/, why: '删除远端受保护分支' },
  { re: /\bgit\s+push\b[^|;]*\s(-f|--force)\s*$/, why: '强推（未指定分支）' },
  { re: /\b(Restart-Computer|Stop-Computer)\b/i, why: '关机或重启机器' },
  { re: /\bformat\s+[a-zA-Z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { re: /\bcipher\s+\/w\b/i, why: '擦除磁盘空闲空间' },
  { re: /\bvssadmin\s+delete\s+shadows\b/i, why: '删除卷影副本' },
  { re: /\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i, why: '格式化或初始化磁盘' },
  { re: />\s*\/dev\/(sd|hd|nvme)/, why: '重定向覆盖裸设备' },
];

const ASK = [
  { re: /\bgit\s+push\b[^|;]*\s(-f|--force)\b/, why: '强推，可能覆盖远端历史' },
  { re: /\bgit\s+push\b[^|;]*\s\+[^\s:]/, why: '强推 refspec，可能覆盖远端历史' },
  { re: /\bgit\s+push\b[^|;]*\s:[^\s]+/, why: '删除远端分支或引用' },
  { re: /\bgit\s+reset\s+--hard\b/, why: '丢弃工作区改动' },
  { re: /\bgit\s+clean\b[^|;]*(\s-[a-zA-Z]*[fdx][a-zA-Z]*\b|\s--force\b)/, why: '删除未跟踪文件' },
  { re: /\bgit\s+reset\s+--(hard|mixed)\b/, why: '重置提交，可能丢失改动' },
  { re: /\bgit\s+checkout\s+(--\s+)?\./, why: '丢弃所有本地改动' },
  { re: /\bgit\s+restore\s+(--\S+\s+)*\./, why: '丢弃所有本地改动' },
  { re: /\bgit\s+branch\b[^|;]*(-D\b|(--delete|-[a-zA-Z]*d[a-zA-Z]*)\b[^|;]*(--force|-f\b)|(--force|-f\b)[^|;]*(--delete|-[a-zA-Z]*d[a-zA-Z]*)\b)/, why: '强制删除本地分支' },
  { re: /\bgit\s+push\s+\S+\s+--delete\b/, why: '删除远端分支' },
  { re: /\bnpm\s+publish\b/, why: '发布包到 registry' },
  { re: /\bdocker\s+(rm|rmi)\s+-f\b/, why: '强制删除容器或镜像' },
  { re: /\bdocker\s+system\s+prune\b/, why: '清理 Docker 资源' },
  { re: /\b(kubectl\s+delete|helm\s+uninstall)\b/, why: '删除集群资源' },
  { re: /\bmigrate\b[^|;]*\b(down|reset|rollback)\b/i, why: '回滚数据库迁移' },
  { re: /\bgit\s+update-ref\s+-d\b/, why: '删除 Git 引用' },
  { re: /\bgit\s+filter-branch\b/, why: '重写 Git 历史' },
  { re: /\bgit\s+push\s+\S*\s*--mirror\b/, why: '镜像推送，可能覆盖远端所有引用' },
  { re: /\bgit\s+reflog\s+expire\b/, why: '清空 reflog，丢失恢复线索' },
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
const WRAPPERS = new Set(['sudo', 'command', 'doas', 'time', 'nohup', 'nice', 'builtin', 'exec']);
const HALT_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
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
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1];
      i += 1;
      started = true;
      continue;
    }
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

function stripWrappers(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const name = baseName(tokens[i].value);
    if (name === 'time') {
      i += 1;
      if (tokens[i]?.value === '-p') i += 1;
      continue;
    }
    if (name === 'nice') {
      i += 1;
      if (tokens[i]?.value === '-n') i += 2;
      continue;
    }
    if (WRAPPERS.has(name)) { i += 1; continue; }
    if (name === 'env') {
      i += 1;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

const ROOTISH = /^(?:\/|~|\$HOME|\.{1,2})\/?$/;
const BROAD_TARGET = /^(?:\/|\.{1,2}\/)?\*+$/;

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
  if (recursive && targets.some((t) => ROOTISH.test(t))) {
    return [{ decision: 'deny', why: '递归删除根目录或当前目录' }];
  }
  if (recursive && force && targets.some((t) => BROAD_TARGET.test(t))) {
    return [{ decision: 'deny', why: '递归强制删除通配符' }];
  }
  if (recursive && force) return [{ decision: 'ask', why: '递归强制删除' }];
  if (force && targets.length === 0) return [{ decision: 'ask', why: '强制删除（未指定目标）' }];
  return [];
}

const WIN_ROOT = /^[a-zA-Z]:\\?\*?$/;

/** Windows 的 rd/del/Remove-Item 递归删除不在全局正则里逐条覆盖，按命令位置判断。 */
function winDeleteDecision(cmd, args) {
  const name = cmd.replace(/\.exe$/i, '').toLowerCase();
  const values = args.map((t) => t.value);
  const hasSwitch = (re) => values.some((v) => re.test(v));
  const target = values.find((v) => !v.startsWith('/') && !v.startsWith('-'));
  if (name === 'rd' || name === 'rmdir') {
    if (!hasSwitch(/^\/[a-z]*s[a-z]*$/i)) return [];
    if (target && WIN_ROOT.test(target)) return [{ decision: 'deny', why: '递归删除盘符根' }];
    return [{ decision: 'ask', why: '递归删除目录，可能丢数据' }];
  }
  if (name === 'del' || name === 'erase') {
    if (!hasSwitch(/^\/[a-z]*s[a-z]*$/i)) return [];
    if (target && WIN_ROOT.test(target)) return [{ decision: 'deny', why: '递归删除盘符根' }];
    return [{ decision: 'ask', why: '递归删除文件，可能丢数据' }];
  }
  if (name === 'remove-item' || name === 'ri') {
    if (!hasSwitch(/^(?:-recurse|\/recurse)$/i)) return [];
    if (target && WIN_ROOT.test(target)) return [{ decision: 'deny', why: '递归删除盘符根' }];
    return [{ decision: 'ask', why: '递归删除文件或目录，可能丢数据' }];
  }
  return [];
}

function xargsDecision(args) {
  const target = args.find((t) => !t.value.startsWith('-'));
  if (target && baseName(target.value) === 'rm') {
    return [{ decision: 'ask', why: 'xargs 调用 rm，删除目标由输入决定' }];
  }
  return [];
}

function findDecision(args) {
  const values = args.map((t) => t.value);
  const i = values.findIndex((v) => ['-exec', '-execdir', '-ok', '-okdir'].includes(v));
  const target = i >= 0 ? values[i + 1] : null;
  if (target && baseName(target) === 'rm') {
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
  const cmd = baseName(tokens[0].value);
  if (SHELLS.has(cmd)) {
    for (let i = 1; i < tokens.length; i += 1) {
      if (['-c', '-Command', '-command', '/c'].includes(tokens[i].value)) {
        return commandAfter(tokens, i);
      }
    }
    return null;
  }
  if (cmd === 'cmd') {
    const i = tokens.findIndex((t, idx) => idx > 0 && /^\/c$/i.test(t.value));
    return i >= 0 ? commandAfter(tokens, i) : null;
  }
  if (cmd === 'eval') return tokens.slice(1).map((t) => t.value).join(' ');
  return null;
}

function sqlTexts(command) {
  const texts = [];
  for (const raw of simpleCommands(tokenize(command))) {
    const group = stripWrappers(raw);
    if (!group.length || !DB_CLIENTS.has(baseName(group[0].value))) continue;
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
    const cmd = baseName(group[0].value);
    if (HALT_COMMANDS.has(cmd)) findings.push({ decision: 'deny', why: '关机或重启机器' });
    else if (cmd === 'systemctl' && group.slice(1).some((t) => /^(reboot|poweroff|halt)$/.test(t.value))) {
      findings.push({ decision: 'deny', why: '关机或重启机器' });
    } else if (cmd === 'rm') {
      findings.push(...rmDecision(group.slice(1)));
    } else if (['rd', 'rmdir', 'del', 'erase', 'remove-item', 'ri']
      .includes(cmd.replace(/\.exe$/i, '').toLowerCase())) {
      findings.push(...winDeleteDecision(cmd, group.slice(1)));
    } else if (cmd === 'xargs') {
      findings.push(...xargsDecision(group.slice(1)));
    } else if (cmd === 'find') {
      findings.push(...findDecision(group.slice(1)));
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

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

try {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  if (payload.tool_name !== 'Bash') process.exit(0);
  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) process.exit(0);

  const hit = decide(command);
  if (hit) {
    const prefix = hit.decision === 'deny' ? 'devflow 安全门禁：' : 'devflow 提醒：';
    emit(hit.decision, `${prefix}${hit.why}${hit.decision === 'ask' ? '，请确认后再执行' : ''}。命令：${command.slice(0, 200)}`);
  }
} catch {
  // 钩子自身异常时放行，避免把正常命令挡死。
}
process.exit(0);
