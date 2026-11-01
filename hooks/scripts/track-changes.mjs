#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Monitor)：记录改动文件。
// 业务代码改动标记测试待验证；阶段源（.claude/hub/）改动只提醒 gen/doctor；
// docs/devflow/ 属于流程文档，不参与提醒。Bash 类工具可能通过 sed -i、格式化器等间接改文件，用 git status 兜底。
import { statSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStdin, findHubRoot, updateState } from './lib.mjs';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const DOCS_PREFIX = 'docs/devflow/';
const HUB_PREFIX = '.claude/hub/';

const LEDGERS = new Set([
  '.claude/.devflow-state.json',
  '.claude/.hub-manifest.json',
  '.claude/.hub-sources.json',
  '.claude/.ecosystem-state.json',
  '.devflow.json',
]);

// 构建产物与依赖目录不视为业务改动，避免生成/安装后反复把测试标记为待验证。
const NOISE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt',
  'target', 'out', 'vendor', '.cache',
]);

// 这些目录下的同名子目录是源码而非构建产物，例如 src/build/index.ts。
const SOURCE_PARENTS = new Set(['src', 'lib', 'app', 'source', 'test', 'tests', 'spec', 'specs']);

// 状态账本自身的锁与临时文件不是项目改动。
function isLedgerArtifact(rel) {
  for (const ledger of LEDGERS) {
    if (rel === `${ledger}.lock` || rel.startsWith(`${ledger}.tmp-`)) return true;
  }
  return false;
}

function isNoise(rel) {
  if (rel.startsWith('.claude/skills/devflow-')) return true;
  if (LEDGERS.has(rel) || isLedgerArtifact(rel)) return true;
  const segments = rel.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!NOISE_DIRS.has(segments[i])) continue;
    if (i > 0 && SOURCE_PARENTS.has(segments[i - 1])) continue;
    return true;
  }
  if (segments.some((s) => /\.bak(-|$)/i.test(s) || /\.tmp(-|$)/i.test(s))) return true;
  return false;
}

/** doc：流程文档，完全忽略；hub：阶段源，只提醒重新生成，不标记测试待验证。 */
function kindOf(rel) {
  if (rel.startsWith(DOCS_PREFIX)) return 'doc';
  if (isNoise(rel)) return 'ignore';
  if (rel.startsWith(HUB_PREFIX)) return 'hub';
  return 'code';
}

function appendFiles(state, key, items) {
  const files = Array.isArray(state[key]) ? state[key].slice() : [];
  for (const rel of items) if (!files.includes(rel)) files.push(rel);
  state[key] = files.slice(-200);
}

function gitChanged(root) {
  // git status 偶尔会因索引锁或大仓库卡住；钩子不能无限等待。
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '-uall'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return [];
  const entries = (result.stdout || '').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].slice(0, 2);
    files.push(entries[i].slice(3).replace(/\\/g, '/'));
    if (status[0] === 'R' || status[0] === 'C') {
      // rename 的原始路径同样发生了删除，必须记录；copy 的源文件未变。
      if (status[0] === 'R' && entries[i + 1]) {
        files.push(entries[i + 1].replace(/\\/g, '/'));
      }
      i += 1;
    }
  }
  return files;
}

const { text: raw } = await readStdin();
let payload = {};
try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

try {
  const root = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const stateFile = join(root, '.claude', '.devflow-state.json');
  const shellTool = SHELL_TOOLS.has(payload.tool_name);

  let fixedRel = null;
  if (!shellTool) {
    const file = payload.tool_input?.file_path
      || payload.tool_input?.path
      || payload.tool_input?.notebook_path;
    if (!file) process.exit(0);
    fixedRel = file;
    if (isAbsolute(file)) fixedRel = relative(root, file).split('\\').join('/');
    // 跨盘符时 relative() 会返回绝对路径，必须再次判断
    if (isAbsolute(fixedRel) || fixedRel.startsWith('..')) process.exit(0);
    const kind = kindOf(fixedRel);
    if (kind === 'doc' || kind === 'ignore') process.exit(0);
  }

  updateState(stateFile, (state) => {
    // 没有历史状态时只回看最近 2 秒，避免把打开会话前就存在的脏文件算成本次改动。
    // 注意不能写 Date.parse(x || 0)：Date.parse(0) 会得到 1999 年，2 秒兜底将永远不生效。
    const parsed = Date.parse(state.lastTrackAt || state.lastChangeAt || '');
    const lastTrackAt = Number.isNaN(parsed) ? Date.now() - 2000 : parsed;

    let changed = [];
    if (shellTool) {
      // 命令后的 git status 会包含执行前就存在的脏文件；只保留本次命令真正改动的路径。
      changed = gitChanged(root).filter((rel) => {
        if (!rel || rel.startsWith('..') || kindOf(rel) === 'ignore' || kindOf(rel) === 'doc') return false;
        // 文件被删除时自身已无 mtime，用父目录的更新时间判断本次操作。
        try { return statSync(join(root, rel)).mtimeMs > lastTrackAt; } catch {
          try { return statSync(dirname(join(root, rel))).mtimeMs > lastTrackAt; } catch { return false; }
        }
      });
    } else {
      changed = [fixedRel];
    }
    if (!changed.length) return state;

    const code = changed.filter((rel) => kindOf(rel) === 'code');
    const hub = changed.filter((rel) => kindOf(rel) === 'hub');
    const now = new Date().toISOString();

    if (code.length) {
      appendFiles(state, 'changedFiles', code);
      state.lastChangeAt = now;
      state.testsPending = true;
    }
    if (hub.length) {
      appendFiles(state, 'hubChangedFiles', hub);
      state.lastHubChangeAt = now;
      state.hubPending = true;
    }
    state.lastTrackAt = now;
    return state;
  });
} catch {
  // 记录失败不应影响文件编辑本身。
}
process.exit(0);
