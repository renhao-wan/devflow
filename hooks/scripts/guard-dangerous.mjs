#!/usr/bin/env node
// PreToolUse(Bash)：危险命令硬门禁。deny 直接阻止，ask 交给用户确认。
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
  { re: /\bDROP\s+(DATABASE|SCHEMA)\b/i, why: '删除数据库结构' },
  { re: /\bTRUNCATE\s+TABLE\b/i, why: '清空数据表' },
  { re: /\b(rd|rmdir)\s+\/s\s+\/q\s+[a-zA-Z]:\\?\s*$/i, why: '递归删除盘符根' },
  { re: /\bdel\s+(\/[a-z]+\s+)+[a-zA-Z]:\\?\s*$/i, why: '递归删除盘符根' },
  { re: /\bformat\s+[a-zA-Z]:/i, why: '格式化磁盘' },
  { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
  { re: /\bcipher\s+\/w\b/i, why: '擦除磁盘空闲空间' },
  { re: /\bvssadmin\s+delete\s+shadows\b/i, why: '删除卷影副本' },
  { re: /\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i, why: '格式化或初始化磁盘' },
  { re: /\bRemove-Item\b[^|;]*-Recurse[^|;]*-Force[^|;]*[a-zA-Z]:\\?\s*$/i, why: '递归删除盘符根' },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/, why: '关机或重启机器' },
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
  { re: /\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/i, why: '删除数据库列' },
  { re: /\bmigrate\b[^|;]*\b(down|reset|rollback)\b/i, why: '回滚数据库迁移' },
  { re: /\bgit\s+update-ref\s+-d\b/, why: '删除 Git 引用' },
  { re: /\bgit\s+filter-branch\b/, why: '重写 Git 历史' },
  { re: /\bgit\s+push\s+\S*\s*--mirror\b/, why: '镜像推送，可能覆盖远端所有引用' },
  { re: /\bgit\s+reflog\s+expire\b/, why: '清空 reflog，丢失恢复线索' },
];

/**
 * 解析 rm 调用：短选项可合并（-fr/-Rf）、长选项（--recursive/--force）
 * 与书写顺序无关，避免 `rm -fr *`、`rm --recursive --force *` 绕过。
 */
function scanRm(command) {
  const hits = [];
  for (const seg of command.split(/&&|\|\||[;|\n&]/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^(sudo|command|env|doas|time)$/.test(tokens[i])) i += 1;
    if (!/^(?:.*[/\\])?rm$/.test(tokens[i] || '')) continue;
    let recursive = false;
    let force = false;
    const targets = [];
    for (const t of tokens.slice(i + 1)) {
      if (t === '--') continue;
      if (t.startsWith('--')) {
        if (t.startsWith('--recursive')) recursive = true;
        if (t.startsWith('--force')) force = true;
        continue;
      }
      if (t.startsWith('-') && t.length > 1) {
        if (/[rR]/.test(t)) recursive = true;
        if (t.includes('f')) force = true;
        continue;
      }
      targets.push(t);
    }
    hits.push({ recursive, force, targets, raw: seg.trim() });
  }
  return hits;
}

const ROOTISH = /^(\/|~(?:\/|$)|\$HOME(?:\/|$)|\.{1,2}(?:\/|$))/;

function rmDecision(command) {
  for (const h of scanRm(command)) {
    const rootish = h.targets.filter((t) => ROOTISH.test(t));
    const wildcard = h.targets.some((t) => /[*?]/.test(t));
    if (h.recursive && rootish.length) {
      return { decision: 'deny', why: `递归删除根目录或当前目录（${h.raw.slice(0, 120)}）` };
    }
    if (h.recursive && h.force && wildcard) {
      return { decision: 'deny', why: `递归强制删除通配符（${h.raw.slice(0, 120)}）` };
    }
    if (h.recursive && h.force) {
      return { decision: 'ask', why: '递归强制删除' };
    }
    if (h.force && h.targets.length === 0) {
      return { decision: 'ask', why: '强制删除（未指定目标）' };
    }
  }
  return null;
}

function emit(decision, reason) {
  if (!decision) return;
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

  const rm = rmDecision(command);
  if (rm?.decision === 'deny') {
    emit('deny', `devflow 安全门禁：${rm.why}。命令：${command.slice(0, 200)}`);
    process.exit(0);
  }

  for (const rule of DENY) {
    if (rule.re.test(command)) {
      emit('deny', `devflow 安全门禁：${rule.why}。命令：${command.slice(0, 200)}`);
      process.exit(0);
    }
  }
  if (rm?.decision === 'ask') {
    emit('ask', `devflow 提醒：${rm.why}，请确认后再执行。`);
    process.exit(0);
  }
  for (const rule of ASK) {
    if (rule.re.test(command)) {
      emit('ask', `devflow 提醒：${rule.why}，请确认后再执行。`);
      process.exit(0);
    }
  }
} catch {
  // 钩子自身异常时放行，避免把正常命令挡死。
}
process.exit(0);
