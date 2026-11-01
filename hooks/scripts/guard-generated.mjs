#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit)：拒绝手改生成物。生成物由 devflow 脚本维护，
// 手改会在下一次 gen/sync/init 时被覆盖，并让账本与投影漂移。钩子自身异常时放行。
import { join, relative, isAbsolute } from 'node:path';
import { writeSync } from 'node:fs';
import { readStdin, findHubRoot } from './lib.mjs';

const LEDGERS = new Set([
  '.claude/.hub-manifest.json',
  '.claude/.hub-sources.json',
  '.claude/.devflow-state.json',
  '.devflow.json',
]);

const LOADERS = new Set([
  'scripts/devflow-gen.mjs',
  'scripts/devflow-doctor.mjs',
  'scripts/devflow-route.mjs',
  'scripts/devflow-upstream.mjs',
  'scripts/devflow-test.mjs',
]);

const ECOSYSTEM_STATE = '.claude/.ecosystem-state.json';

function projectFileRel(payload) {
  const input = payload.tool_input || {};
  const file = input.file_path || input.notebook_path || input.path;
  if (typeof file !== 'string' || !file.trim()) return null;

  const start = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // 只在已初始化的 hub 工作区生效；没有 hub.yaml 时所有文件都由用户自由管理。
  const root = findHubRoot(start);
  if (!root) return null;
  const rel = isAbsolute(file) ? relative(root, file) : file;
  const posix = rel.split('\\').join('/');
  // 跨盘符或指向项目外时不介入。
  if (isAbsolute(rel) || posix.startsWith('../') || posix === '..') return null;
  return posix;
}

function reason(rel) {
  if (rel === ECOSYSTEM_STATE) {
    return '工具检测结果是生成物。请运行 devflow route --detect 刷新，而不是手改。';
  }
  if (rel === '.claude/.devflow-state.json') {
    return 'devflow 状态文件由钩子与脚本维护。请用 /devflow:test 或 node scripts/devflow-test.mjs 更新；'
      + '确需重置时手动删除该文件。';
  }
  if (LEDGERS.has(rel)) {
    return 'devflow 账本由脚本维护，手改会造成投影或同步漂移。'
      + '请运行 node scripts/devflow-gen.mjs（或 node scripts/devflow-doctor.mjs）重建。';
  }
  if (LOADERS.has(rel)) {
    return 'devflow loader 是生成物。请重新运行 /devflow:init（或 node scripts/hub-init.mjs --force）刷新。';
  }
  if (rel.startsWith('.claude/skills/devflow-')) {
    const parts = rel.split('/');
    const stage = (parts[2] || 'devflow-<stage>').replace(/^devflow-/, '') || '<stage>';
    return `该技能投影由 devflow 生成。请修改 .claude/hub/stages/${stage}/SKILL.md（或 .claude/hub/_shared/），`
      + '然后运行 node scripts/devflow-gen.mjs。';
  }
  return null;
}

try {
  const { text: raw, complete } = await readStdin();
  const sessionRoot = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!sessionRoot) process.exit(0);
  // 输入不完整时无法判断目标，交给用户确认，避免把生成物写坏。
  if (!complete) {
    writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'devflow 提醒：编辑输入未完整读取，无法确认目标是否为生成物，请确认后再执行。',
      },
    }));
    process.exit(0);
  }

  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(payload.tool_name)) process.exit(0);

  const rel = projectFileRel(payload);
  if (!rel) process.exit(0);
  const why = reason(rel);
  if (!why) process.exit(0);

  writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `devflow 生成物写保护：${why}`,
    },
  }));
} catch {
  // 钩子失败不应挡住正常编辑。
}
process.exit(0);
