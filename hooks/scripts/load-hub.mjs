#!/usr/bin/env node
// SessionStart：注入 hub 摘要，让模型一开始就知道本项目的流程与漂移状态。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function findRoot(start) {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.claude', 'hub', 'hub.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseStages(yaml) {
  const block = /^stages:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml);
  if (!block) return [];
  return [...block[1].matchAll(/^\s*-\s*(\w+)\s*$/gm)].map((m) => m[1]);
}

function parseSubprojects(yaml) {
  const block = /^subprojects:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml);
  if (!block) return [];
  return [...block[1].matchAll(/^ {2}(?:"([^"]+)"|'([^']+)'|([\w.-]+)):\s*$/gm)]
    .map((m) => m[1] || m[2] || m[3]);
}

await readStdin();
try {
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) process.exit(0);

  const yaml = readFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'utf8');
  const stages = parseStages(yaml);
  const subs = parseSubprojects(yaml);

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
  lines.push('- 流程：/devflow:req → plan → implement → test → review → debug');
  lines.push('- 单一真源：.claude/hub/stages/<stage>/SKILL.md，改动后重新生成技能。');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  }));
} catch {
  // 注入失败时静默，不打断会话启动。
}
process.exit(0);
