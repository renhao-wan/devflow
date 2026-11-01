#!/usr/bin/env node
// SessionStart：注入 hub 摘要，让模型一开始就知道本项目的流程与漂移状态。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, findHubRoot } from './lib.mjs';
import { parseYaml, contentHash } from '../../scripts/lib/common.mjs';

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
        const target = String(s.target);
        // 只读取生成器管辖的投影，避免账本把钩子引到项目外。
        if (!target.startsWith('.claude/skills/devflow-') || !target.endsWith('/SKILL.md') || target.includes('..')) continue;
        const targetAbs = join(root, ...target.split('/'));
        if (!existsSync(targetAbs)) {
          drift.push(`${s.name}（缺失）`);
          continue;
        }
        // 与生成器使用同一套行尾归一化哈希，否则 CRLF 会被误报为手改。
        if (contentHash(readFileSync(targetAbs, 'utf8')) !== s.hash) drift.push(`${s.name}（已改）`);
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

  // 只在项目显式配置生态索引时注入，避免给未启用的项目增加噪音。
  const ecoFile = join(root, '.claude', 'hub', 'ecosystem.yaml');
  if (existsSync(ecoFile)) {
    let mode = 'ask';
    const disabled = new Set();
    try {
      const eco = parseYaml(readFileSync(ecoFile, 'utf8'));
      const declared = eco?.routing?.mode;
      if (['off', 'ask', 'auto'].includes(declared)) mode = declared;
      for (const [id, tool] of Object.entries(eco?.tools || {})) {
        if (tool && tool.enabled === false) disabled.add(id);
      }
    } catch { /* 配置损坏时按默认 ask 展示，路由命令自身会回退 */ }
    let available = [];
    try {
      const ecoState = JSON.parse(readFileSync(join(root, '.claude', '.ecosystem-state.json'), 'utf8'));
      available = Object.entries(ecoState.tools || {})
        .filter(([id, value]) => value?.available === true && !disabled.has(id))
        .map(([id]) => id);
    } catch { /* 未检测过 */ }
    const toolsText = available.length ? `；可用工具：${available.join('、')}` : '；可用工具：未检测到';
    lines.push(`- 工具路由：${mode}${toolsText}。进入阶段先运行 devflow route --stage <stage>；auto 仅自动委派 technique，workflow 只建议；--force-devflow 强制使用 devflow。`);
  }

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
