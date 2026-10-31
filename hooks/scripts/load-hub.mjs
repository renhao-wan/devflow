#!/usr/bin/env node
// SessionStart：注入 hub 摘要，让模型一开始就知道本项目的流程与漂移状态。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readStdin, findHubRoot } from './lib.mjs';
import { parseYaml } from '../../scripts/lib/common.mjs';

await readStdin();
try {
  const root = findHubRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const yaml = readFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'utf8');
  let config = {};
  try { config = parseYaml(yaml); } catch { config = {}; }
  const stages = Array.isArray(config.stages) ? config.stages.map(String) : [];
  const subs = Object.keys(config.subprojects || {});

  const drift = [];
  const manifestFile = join(root, '.claude', '.hub-manifest.json');
  if (existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      for (const s of manifest.skills || []) {
        if (!s.hash || !s.target) continue;
        const target = join(root, ...String(s.target).split('/'));
        if (!existsSync(target)) {
          drift.push(`${s.name}（缺失）`);
          continue;
        }
        const hash = createHash('sha256').update(readFileSync(target, 'utf8')).digest('hex');
        if (hash !== s.hash) drift.push(`${s.name}（已改）`);
      }
    } catch { /* ignore */ }
  }

  const lines = [
    'devflow 工作区已加载。',
    `- 项目根：${root.split('\\').join('/')}`,
    `- 阶段：${stages.join(', ') || '（未声明）'}`,
    `- 子项目：${subs.join(', ') || '单项目'}`,
  ];
  if (drift.length) lines.push(`- 投影漂移：${drift.join('、')}，运行 node scripts/devflow-gen.mjs`);
  lines.push('- 流程：req → plan → implement → test → review；test 或 implement 失败时进入 debug，修复后回到 test。');
  lines.push('- 单一真源：.claude/hub/stages/<stage>/SKILL.md，改动后重新生成技能。');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
      // /clear、resume 后重新扫描技能目录，确保新生成的投影立即可用
      reloadSkills: true,
    },
  }));
} catch {
  // 注入失败时静默，不打断会话启动。
}
process.exit(0);
