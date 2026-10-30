#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadHub, pluginInfo, findPluginRoot, satisfies, argValue, hasFlag,
  readText, writeAtomic, sha256, log, posix, isMain, projectRoot,
  walk, relPosix, parseFrontmatter, isValidStageName, STAGE_NAME_RE,
  isGeneratedArtifact,
} from './lib/common.mjs';

const MARKER = '> 本文件由 devflow 生成，**勿手改**。';

function stageList(config, root) {
  const declared = config.stages;
  if (Array.isArray(declared) && declared.length) return declared.map(String);
  const dir = join(root, '.claude', 'hub', 'stages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

function stageDescription(root, stage) {
  const file = join(root, '.claude', 'hub', 'stages', stage, 'SKILL.md');
  if (!existsSync(file)) return null;
  const description = parseFrontmatter(readText(file)).description;
  return description || `${stage} 阶段的工程流程`;
}

function subprojectRows(config) {
  const subs = config.subprojects;
  if (!subs || typeof subs !== 'object') return '未声明子项目（按单项目处理）。';
  const rows = Object.entries(subs).map(([name, value]) => {
    const path = value?.path || name;
    const stages = Array.isArray(value?.stages) ? value.stages.join(', ') : '全部';
    return `| ${name} | \`${path}\` | ${stages} |`;
  });
  return ['| 子项目 | 路径 | 阶段 |', '| --- | --- | --- |', ...rows].join('\n');
}

function overrideList(root, stage) {
  const dir = join(root, '.claude', 'hub', 'overrides');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, `${stage}.md`)))
    .map((d) => d.name);
}

function stageResources(root, stage) {
  const dir = join(root, '.claude', 'hub', 'stages', stage);
  return walk(dir)
    .map((file) => relPosix(dir, file))
    .filter((rel) => rel !== 'SKILL.md' && !isGeneratedArtifact(rel))
    .sort();
}

/** 目标必须落在 .claude/skills/devflow-<stage>/ 内，避免账本或阶段名把文件写到工作区外。 */
function safeSkillTarget(root, rel) {
  if (!rel || rel.startsWith('/') || rel.includes('..')) return null;
  if (!rel.startsWith('.claude/skills/devflow-')) return null;
  const parts = rel.split('/');
  if (parts.length !== 4 || parts[3] !== 'SKILL.md') return null;
  return join(root, ...parts);
}

function buildSkill(root, stage, config) {
  const source = `.claude/hub/stages/${stage}/SKILL.md`;
  const sourceAbs = join(root, ...source.split('/'));
  if (!existsSync(sourceAbs)) {
    return { stage, error: `缺少源文件 ${source}` };
  }
  const description = stageDescription(root, stage);
  const overrides = overrideList(root, stage);
  const resources = stageResources(root, stage);
  const resourceBlock = resources.length
    ? resources.map((rel) => `- \`${rel}\``).join('\n')
    : '- 当前没有额外资源。';
  const overrideBlock = overrides.length
    ? overrides.map((s) => `- 处理 \`${s}\` 时，优先读取 \`.claude/hub/overrides/${s}/${stage}.md\`。`).join('\n')
    : '- 当前没有子项目级覆盖。';

  const body = `${MARKER}
> 源：\`.claude/hub/stages/${stage}/SKILL.md\`
> 重新生成：\`node scripts/devflow-gen.mjs\`

# devflow / ${stage}

## 何时使用

${description}

## 单一真源

执行前必须完整读取 \`${source}\`。
其中的 \`references/\`、\`templates/\` 等相对引用，以**该文件所在目录**为基准。

## 阶段资源

以下文件随阶段提供，按需读取（相对 \`.claude/hub/stages/${stage}/\`）：

${resourceBlock}

## 当前工作区

${subprojectRows(config)}

## 子项目覆盖

${overrideBlock}

## 门禁

以源文件中的门禁为准；门禁不满足时不得进入下一阶段，必须说明缺口。

## 产出

以源文件中的产出约定为准。存在 \`templates/\` 下的骨架时，以模板为结构，不要自行发明。没有写产出路径时，先向用户确认。

## 边界

- 不改与本阶段无关的文件。
- 不伪造验证结果；没有运行就明确说明没有运行。
`;

  return {
    stage,
    name: `devflow-${stage}`,
    target: `.claude/skills/devflow-${stage}/SKILL.md`,
    source,
    description,
    resources,
    content: `---\nname: devflow-${stage}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
  };
}

function readManifest(root) {
  const file = join(root, '.claude', '.hub-manifest.json');
  if (!existsSync(file)) return { skills: [] };
  try {
    const data = JSON.parse(readText(file));
    data.skills = (data.skills || []).map((s) => (typeof s === 'string' ? { name: s } : s));
    return data;
  } catch {
    return { skills: [] };
  }
}

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const check = hasFlag(argv, '--check');
  const dryRun = hasFlag(argv, '--dry-run');
  const json = hasFlag(argv, '--json');
  const force = hasFlag(argv, '--force');

  const { config, file: hubFile } = loadHub(root);
  const pluginRoot = hasFlag(argv, '--no-plugin') ? null : findPluginRoot(root);
  const version = pluginRoot ? pluginInfo(pluginRoot).version : null;
  const requires = config.requiresPlugin || '*';

  if (version && !satisfies(version, requires)) {
    throw new Error(`插件版本 ${version} 不满足 hub.yaml 的 requiresPlugin ${requires}。请先升级插件。`);
  }

  const stages = stageList(config, root);
  const results = [];
  const errors = [];
  for (const stage of stages) {
    if (!isValidStageName(stage)) {
      errors.push({ stage, error: `阶段名 "${stage}" 非法：只允许小写字母开头的 [a-z0-9_-]。` });
      continue;
    }
    const built = buildSkill(root, stage, config);
    if (built.error) errors.push(built);
    else results.push(built);
  }

  const previous = readManifest(root);
  const currentNames = new Set(results.map((r) => r.name));
  const stale = previous.skills.filter((s) => s.name && !currentNames.has(s.name));

  const drift = [];
  for (const r of results) {
    const target = safeSkillTarget(root, r.target);
    if (!target) {
      errors.push({ stage: r.stage, error: `目标路径越界：${r.target}` });
      continue;
    }
    if (!existsSync(target)) drift.push({ ...r, reason: 'missing' });
    else if (sha256(readText(target)) !== sha256(r.content)) drift.push({ ...r, reason: 'changed' });
  }
  for (const s of stale) drift.push({ name: s.name, target: s.target, reason: 'stale' });
  for (const e of errors) drift.push({ name: `devflow-${e.stage}`, reason: 'source-missing', detail: e.error });

  const report = {
    root: posix(root),
    pluginVersion: version,
    requiresPlugin: requires,
    stages: results.map((r) => ({ name: r.name, target: r.target, source: r.source })),
    drift,
    errors: errors.map((e) => e.detail),
    check,
    dryRun,
  };

  if (check) {
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const r of results) {
        const d = drift.find((x) => x.target === r.target);
        log(d ? 'warn' : 'ok', `${r.name}${d ? `（${d.reason}）` : ''}`);
      }
      for (const s of stale) log('warn', `${s.name} 已过期，建议删除`);
      for (const e of errors) log('error', e.error);
      log(drift.length ? 'warn' : 'ok', drift.length ? `发现 ${drift.length} 处漂移` : '投影与 hub 一致');
    }
    if (drift.length) process.exitCode = 1;
    return report;
  }

  if (dryRun) {
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const r of results) log('..', `将写入 ${r.target}`);
      for (const s of stale) log('..', `将删除 ${s.target || s.name}`);
    }
    return report;
  }

  for (const r of results) {
    const target = safeSkillTarget(root, r.target);
    if (!target) {
      errors.push({ stage: r.stage, error: `目标路径越界，跳过：${r.target}` });
      continue;
    }
    if (existsSync(target) && !force) {
      const managed = previous.skills.some((s) => s.name === r.name);
      if (!managed && sha256(readText(target)) !== sha256(r.content)) {
        errors.push({ stage: r.stage, error: `${r.target} 已存在且不受 devflow 管理，跳过。使用 --force 覆盖。` });
        continue;
      }
    }
    writeAtomic(target, r.content);
    log('ok', `写入 ${r.target}`);
  }

  for (const s of stale) {
    if (!s.target) continue;
    const target = safeSkillTarget(root, s.target);
    if (!target) {
      log('warn', `账本中的过期目标不合法，跳过：${s.target}`);
      continue;
    }
    if (existsSync(target)) {
      const parts = s.target.split('/');
      const dir = join(root, ...parts.slice(0, -1));
      const siblings = readdirSync(dir);
      if (siblings.length === 1 && siblings[0] === 'SKILL.md') {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
        log('ok', `清理过期技能 ${s.name}`);
      }
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pluginVersion: version,
    requiresPlugin: requires,
    source: '.claude/hub',
    skills: results.map((r) => ({
      name: r.name,
      target: r.target,
      source: r.source,
      hash: sha256(r.content),
      resources: r.resources,
    })),
  };
  writeAtomic(join(root, '.claude', '.hub-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log('ok', `生成 ${results.length} 个技能 → .claude/skills/`);
  for (const e of errors) log('error', e.error);
  if (errors.length) process.exitCode = 1;
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
