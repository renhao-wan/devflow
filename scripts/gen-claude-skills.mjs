#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  loadHub, pluginInfo, findPluginRoot, satisfies, argValue, hasFlag,
  readText, writeAtomic, contentHash, normalizeEol, canonicalPath, log, posix, isMain, projectRoot,
  ensureDir, walk, relPosix, parseFrontmatter, isValidStageName, isGeneratedArtifact, isRealPathInside, isDraft,
  warnUnknownArgs, LOG_TAGS,
} from './lib/common.mjs';
import { planStacks } from './lib/stacks.mjs';
import { resolveStages } from './lib/stages.mjs';

const MARKER = '> 本文件由 devflow 生成，**勿手改**。';

function stageDescription(root, stage) {
  const file = join(root, '.claude', 'hub', 'stages', stage, 'SKILL.md');
  if (!existsSync(file)) return null;
  const description = parseFrontmatter(readText(file)).description;
  return description || `${stage} 阶段的工程流程`;
}

function subprojectRows(config, stackPlan) {
  const subs = config.subprojects;
  if (!subs || typeof subs !== 'object' || Array.isArray(subs)) return '未声明子项目（按单项目处理）。';
  const stackBySub = new Map((stackPlan?.rows || []).map((row) => [row.subproject, row]));
  const rows = Object.entries(subs).map(([name, value]) => {
    const path = value?.path || name;
    const stages = Array.isArray(value?.stages) ? value.stages.join(', ') : '全部';
    const stackRow = stackBySub.get(name);
    const stack = !stackRow
      ? '—'
      : stackRow.invalidConfig
        ? '配置无效（检查 hub.yaml）'
        : `${stackRow.stack}${stackRow.invalidName ? '（名称非法）' : stackRow.dirExists ? '' : '（缺失）'}`;
    return `| ${name} | \`${path}\` | ${stages} | ${stack} |`;
  });
  return ['| 子项目 | 路径 | 阶段 | 技术栈 |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function stackSection(stackPlan, stage) {
  const rows = stackPlan?.rows || [];
  if (!rows.length) {
    return '当前没有声明技术栈。可在 `hub.yaml` 设置顶层 `stack` 或 `subprojects.<name>.stack`，'
      + '并把规范放到 `.claude/hub/stacks/<stack>/`。';
  }
  const invalidConfig = rows.some((row) => row.invalidConfig);
  const table = rows.map((row) => {
    const stageFile = row.stageFile?.[stage];
    const sharedFile = row.sharedFile;
    const stack = row.invalidConfig
      ? '配置无效（检查 hub.yaml）'
      : row.invalidName
        ? `${row.stack}（名称非法，检查 hub.yaml）`
        : `${row.stack}${row.dirExists ? '' : '（缺失，运行 /devflow:sync）'}`;
    return `| ${row.subproject} | \`${row.path}\` | ${stack} | `
      + `${stageFile ? `\`${stageFile}\`` : '—'} | ${sharedFile ? `\`${sharedFile}\`` : '—'} |`;
  });
  return [
    '映射来自 `hub.yaml` 的 `stack` 字段与 `.claude/hub/stacks/`。进入阶段后，只读取任务涉及子项目的对应文件，不要预读所有栈规范。',
    ...(invalidConfig ? ['', '部分 `stack` 声明不是字符串，已标为「配置无效」；请检查 `hub.yaml`，未修正前不要按该行读取栈规范。'] : []),
    '',
    '| 子项目 | 路径 | 技术栈 | 本阶段规范 | 通用规范 |',
    '| --- | --- | --- | --- | --- |',
    ...table,
    '',
    '规则优先级：阶段门禁与安全底线 > `overrides` > `stacks/<stack>/<stage>.md` > `stacks/<stack>/_shared.md` > `_shared` > 阶段默认做法。',
    '技术栈规范不得放宽门禁或安全底线。',
    '技术栈目录中的草稿不会列出；填写后删除首行的草稿标记，再运行 gen。',
  ].join('\n');
}

function stackManifest(stackPlan) {
  return (stackPlan?.stacks || []).map((stack) => ({
    name: stack.name,
    dir: stack.dir,
    shared: stack.shared,
    stages: stack.stages,
  }));
}

function overrideList(root, stage) {
  const dir = join(root, '.claude', 'hub', 'overrides');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => {
      const file = join(dir, d.name, `${stage}.md`);
      return existsSync(file) && !isDraft(readText(file));
    })
    .map((d) => d.name);
}

function stageResources(root, stage) {
  const dir = join(root, '.claude', 'hub', 'stages', stage);
  return walk(dir)
    // 草稿不是规则：TODO 不能作为参考资料交给阶段执行。
    .filter((file) => !isDraft(readText(file)))
    .map((file) => relPosix(dir, file))
    .filter((rel) => rel !== 'SKILL.md' && !isGeneratedArtifact(rel))
    .sort();
}

/** 读取项目级共享规则：对所有阶段生效，随投影一起分发。 */
function sharedRules(root) {
  const dir = join(root, '.claude', 'hub', '_shared');
  return walk(dir, '.md')
    .map((abs) => ({
      path: `.claude/hub/_shared/${relPosix(dir, abs)}`,
      rel: relPosix(dir, abs),
      content: normalizeEol(readText(abs)).trim(),
      hash: contentHash(readText(abs)),
    }))
    .filter((s) => s.content && !isGeneratedArtifact(s.rel) && !isDraft(s.content))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 草稿不会进入投影；统一统计，告诉用户哪些规则还没有启用。 */
function unusedDrafts(root) {
  const out = [];
  for (const name of ['_shared', 'stages', 'stacks', 'overrides']) {
    for (const abs of walk(join(root, '.claude', 'hub', name), '.md')) {
      if (!isDraft(readText(abs))) continue;
      const rel = relPosix(root, abs);
      // 阶段入口草稿会让 buildSkill 报错，不重复计入“未启用草稿”。
      if (/^\.claude\/hub\/stages\/[^/]+\/SKILL\.md$/.test(rel)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

/** 目标必须落在 .claude/skills/devflow-<stage>/ 内，且真实路径不能跳出项目（防 junction/符号链接）。 */
function safeSkillTarget(root, rel) {
  if (!rel || rel.startsWith('/') || rel.includes('..')) return null;
  if (!rel.startsWith('.claude/skills/devflow-')) return null;
  const parts = rel.split('/');
  if (parts.length !== 4 || parts[3] !== 'SKILL.md') return null;
  const target = join(root, ...parts);

  // 目标或父目录可能是符号链接：用最近的已存在祖先做真实路径校验。
  let anchor = target;
  while (!existsSync(anchor)) {
    const parent = dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
  }
  const rootReal = canonicalPath(root);
  const anchorReal = canonicalPath(anchor);
  if (anchorReal !== rootReal && !anchorReal.startsWith(`${rootReal}/`)) return null;
  return target;
}

function buildSkill(root, stage, config, shared, stackPlan) {
  const source = `.claude/hub/stages/${stage}/SKILL.md`;
  const sourceAbs = join(root, ...source.split('/'));
  if (!existsSync(sourceAbs)) {
    return { stage, error: `缺少源文件 ${source}` };
  }
  // 阶段入口是流程骨架，不能是草稿；否则整个阶段都会读取到 TODO 占位。
  if (isDraft(readText(sourceAbs))) {
    return { stage, error: `${source} 带草稿标记：阶段入口不支持草稿，请删除首行标记后再生成。` };
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
  const sharedBlock = shared.length
    ? shared.map((s) => `- \`${s.path}\``).join('\n')
    : '- 当前没有共享规则。';

  const body = `${MARKER}
> 源：\`.claude/hub/stages/${stage}/SKILL.md\`
> 重新生成：\`node scripts/devflow-gen.mjs\`

# devflow / ${stage}

## 何时使用

${description}

## 单一真源

执行前必须完整读取 \`${source}\`。
投影只记录 \`_shared\`、\`overrides\` 与 \`stacks\` 的路径，正文均按下方指令惰性读取，不复制进本文件。
其中的 \`references/\`、\`templates/\` 等相对引用，以**该文件所在目录**为基准。

## 共享规则

以下文件来自 \`.claude/hub/_shared/\`，对所有阶段生效；执行前必须逐个完整读取，不要只凭记忆。
阶段正文可补充，但不得放宽其中的安全与门禁要求。

${sharedBlock}

## 阶段资源

以下文件随阶段提供，按需读取（相对 \`.claude/hub/stages/${stage}/\`）：

${resourceBlock}

## 当前工作区

${subprojectRows(config, stackPlan)}

## 技术栈规范

${stackSection(stackPlan, stage)}

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
    shared: shared.map((s) => s.rel),
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
  warnUnknownArgs(argv, ['--root', '--check', '--dry-run', '--force', '--json', '--no-plugin']);
  const root = argValue(argv, '--root', projectRoot());
  const check = hasFlag(argv, '--check');
  const dryRun = hasFlag(argv, '--dry-run');
  const json = hasFlag(argv, '--json');
  const force = hasFlag(argv, '--force');
  // JSON 模式下 stdout 只输出报告，过程日志走 stderr，避免把输出流混在一起；标签与 log() 同为小写转大写。
  const emit = json
    ? (status, message) => process.stderr.write(`[${LOG_TAGS[status] || status}] ${message}\n`)
    : log;

  const { config, file: hubFile } = loadHub(root);
  const pluginRoot = hasFlag(argv, '--no-plugin') ? null : findPluginRoot(root);
  const version = pluginRoot ? pluginInfo(pluginRoot).version : null;
  const requires = config.requiresPlugin || '*';

  if (version && !satisfies(version, requires)) {
    throw new Error(`插件版本 ${version} 不满足 hub.yaml 的 requiresPlugin ${requires}。请先升级插件。`);
  }

  const stagePlan = resolveStages(config, root);
  const stages = stagePlan.stages;
  const shared = sharedRules(root);
  const drafts = unusedDrafts(root);
  const stackPlan = planStacks(root, config, stages);
  const results = [];
  const errors = [];
  if (stagePlan.error) errors.push({ stage: null, error: stagePlan.error });
  errors.push(...stackPlan.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ stage: null, error: issue.message })));
  for (const stage of stages) {
    if (!isValidStageName(stage)) {
      errors.push({ stage, error: `阶段名 "${stage}" 非法：只允许小写字母开头的 [a-z0-9_-]。` });
      continue;
    }
    const built = buildSkill(root, stage, config, shared, stackPlan);
    if (built.error) errors.push(built);
    else results.push(built);
  }

  const previous = readManifest(root);
  const erroredStages = new Set(errors.map((e) => e.stage));
  const currentNames = new Set(results.map((r) => r.name));
  // stages 类型错误时无法判断哪些投影该保留：不清空账本，也不删除现有投影。
  const stale = stagePlan.error ? [] : previous.skills.filter((s) => s.name
    && !currentNames.has(s.name)
    && !erroredStages.has(s.name.replace(/^devflow-/, '')));

  const drift = [];
  for (const r of results) {
    const target = safeSkillTarget(root, r.target);
    if (!target) {
      errors.push({ stage: r.stage, error: `目标路径越界：${r.target}` });
      continue;
    }
    if (!existsSync(target)) drift.push({ ...r, reason: 'missing' });
    else if (contentHash(readText(target)) !== contentHash(r.content)) drift.push({ ...r, reason: 'changed' });
  }
  for (const s of stale) drift.push({ name: s.name, target: s.target, reason: 'stale' });
  for (const e of errors) {
    if (e.stage) drift.push({ name: `devflow-${e.stage}`, reason: 'source-missing', detail: e.error });
  }

  const report = {
    root: posix(root),
    pluginVersion: version,
    requiresPlugin: requires,
    stages: results.map((r) => ({ name: r.name, target: r.target, source: r.source })),
    drift,
    errors: errors.map((e) => e.error ?? e.detail ?? String(e)),
    written: [],
    skipped: [],
    drafts: { unused: drafts.length, paths: drafts },
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
      if (drafts.length) log('info', `${drafts.length} 个草稿未启用：${drafts.join('、')}`);
    }
    if (drift.length || errors.length) process.exitCode = 1;
    return report;
  }

  if (dryRun) {
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const r of results) log('..', `将写入 ${r.target}`);
      for (const s of stale) log('..', `将删除 ${s.target || s.name}`);
      if (drafts.length) log('info', `${drafts.length} 个草稿未启用：${drafts.join('、')}`);
    }
    return report;
  }

  const written = [];
  const skipped = [];
  for (const r of results) {
    const target = safeSkillTarget(root, r.target);
    if (!target) {
      errors.push({ stage: r.stage, error: `目标路径越界，跳过：${r.target}` });
      skipped.push(r.target);
      continue;
    }
    if (existsSync(target) && !force) {
      const managed = previous.skills.some((s) => s.name === r.name);
      if (!managed && contentHash(readText(target)) !== contentHash(r.content)) {
        errors.push({ stage: r.stage, error: `${r.target} 已存在且不受 devflow 管理，跳过。使用 --force 覆盖。` });
        skipped.push(r.target);
        continue;
      }
    }
    // 创建目录后再次校验，缩小检查与写入之间被替换成链接的窗口。
    ensureDir(dirname(target));
    const verified = safeSkillTarget(root, r.target);
    if (!verified) {
      errors.push({ stage: r.stage, error: `目标路径越界，跳过：${r.target}` });
      skipped.push(r.target);
      continue;
    }
    writeAtomic(verified, r.content);
    written.push(r);
    emit('ok', `写入 ${r.target}`);
  }

  for (const s of stale) {
    if (!s.target) continue;
    const target = safeSkillTarget(root, s.target);
    if (!target) {
      emit('warn', `账本中的过期目标不合法，跳过：${s.target}`);
      continue;
    }
    if (existsSync(target)) {
      const parts = s.target.split('/');
      const dir = join(root, ...parts.slice(0, -1));
      if (!isRealPathInside(root, dir)) {
        emit('warn', `过期目标越界，跳过清理：${s.target}`);
        continue;
      }
      const siblings = readdirSync(dir);
      if (siblings.length === 1 && siblings[0] === 'SKILL.md') {
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
        emit('ok', `清理过期技能 ${s.name}`);
      }
    }
  }

  // 源文件出错的阶段可能暂时无法生成：保留账本中的旧条目，避免投影失去归属。
  const writtenNames = new Set(written.map((r) => r.name));
  const erroredNames = new Set(errors.filter((e) => e.stage).map((e) => `devflow-${e.stage}`));
  const preserved = previous.skills.filter((s) => s.name && s.target
    && !writtenNames.has(s.name)
    && (stagePlan.error || erroredNames.has(s.name)));

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pluginVersion: version,
    requiresPlugin: requires,
    source: '.claude/hub',
    shared: shared.map((s) => ({ path: s.path })),
    stacks: stackManifest(stackPlan),
    skills: [
      ...written.map((r) => ({
        name: r.name,
        target: r.target,
        source: r.source,
        hash: contentHash(r.content),
        resources: r.resources,
        shared: r.shared,
      })),
      ...preserved,
    ],
  };
  writeAtomic(join(root, '.claude', '.hub-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  emit('ok', `生成 ${written.length} 个技能 → .claude/skills/`);
  if (drafts.length) emit('info', `${drafts.length} 个草稿未启用：${drafts.join('、')}`);
  for (const e of errors) emit('error', e.error);
  if (errors.length) process.exitCode = 1;

  report.written = written.map((r) => r.target);
  report.skipped = skipped;
  report.errors = errors.map((e) => e.error ?? e.detail ?? String(e));
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
