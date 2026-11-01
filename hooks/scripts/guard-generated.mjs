#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit)：拒绝手改生成物。生成物由 devflow 脚本维护，
// 手改会在下一次 gen/sync/init 时被覆盖，并让账本与投影漂移。钩子自身异常时放行。
import { join, relative, isAbsolute } from 'node:path';
import { readStdin, findHubRoot } from './lib.mjs';

const LEDGERS = new Set([
  '.claude/.hub-manifest.json',
  '.claude/.hub-sources.json',
  '.devflow.json',
]);

const LOADERS = new Set([
  'scripts/devflow-gen.mjs',
  'scripts/devflow-doctor.mjs',
  'scripts/devflow-upstream.mjs',
  'scripts/devflow-test.mjs',
]);

function projectFileRel(payload) {
  const input = payload.tool_input || {};
  const file = input.file_path || input.notebook_path || input.path;
  if (typeof file !== 'string' || !file.trim()) return null;

  const start = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findHubRoot(start) || start;
  const rel = isAbsolute(file) ? relative(root, file) : file;
  const posix = rel.split('\\').join('/');
  // 跨盘符或指向项目外时不介入。
  if (isAbsolute(rel) || posix.startsWith('../') || posix === '..') return null;
  return posix;
}

function reason(rel) {
  if (LEDGERS.has(rel)) {
    return 'devflow 账本由脚本维护，手改会造成投影或同步漂移。'
      + '请运行 node scripts/devflow-gen.mjs（或 node scripts/devflow-doctor.mjs）重建。';
  }
  if (LOADERS.has(rel)) {
    return 'devflow loader 是生成物。请重新运行 /devflow:init（或 node scripts/hub-init.mjs --force）刷新。';
  }
  if (rel.startsWith('.claude/skills/devflow-')) {
    const stage = rel.split('/')[3] || '<stage>';
    return `该技能投影由 devflow 生成。请修改 .claude/hub/stages/${stage}/SKILL.md（或 .claude/hub/_shared/），`
      + '然后运行 node scripts/devflow-gen.mjs。';
  }
  return null;
}

try {
  const { text: raw, complete } = await readStdin();
  // 输入不完整时无法判断目标，交给用户确认，避免把生成物写坏。
  if (!complete) {
    process.stdout.write(JSON.stringify({
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

  process.stdout.write(JSON.stringify({
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
