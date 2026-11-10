#!/usr/bin/env node
import { existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, readText, writeText, writeAtomic, pluginInfo, argValue, hasFlag,
  log, posix, isMain, projectRoot, readMeta, isValidPluginRoot, contentHash, normalizeEol,
  isPathInside, isRealPathInside, parseYaml, isDraft,
  warnUnknownArgs,
} from './lib/common.mjs';
import { resolveLibraries, collectTemplateFiles } from './lib/libraries.mjs';
import {
  ECOSYSTEM_FILE, STATE_FILE, createDefaultConfig, loadEcosystem, writeDetectedState,
  ecosystemPath, statePath,
} from './lib/ecosystem.mjs';
import { main as generate } from './gen-claude-skills.mjs';
import { discoverSubprojects, detectTestCommand, detectPackHints } from './lib/discover.mjs';
import { detectWorkspaceStacks } from './lib/stacks.mjs';
import { planDrafts, renderProjectBasicsDraft } from './lib/drafts.mjs';
import { generateOverview, OVERVIEW_FILE } from './lib/overview.mjs';
import { LOADERS, loaderSource } from './lib/loaders.mjs';
import { gitignoreBlock } from './lib/managed-artifacts.mjs';

const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

function pluginRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function renderHubYaml(subprojects, version, rootTest, { templates = null, blocklist = [], stack = null } = {}) {
  const lines = [
    '# devflow 项目真源配置。可以自由修改，改完运行 node scripts/devflow-gen.mjs。',
    'version: 1',
    `requiresPlugin: "^${version}"`,
    'stages:',
    ...STAGES.map((s) => `  - ${s}`),
  ];
  if (stack) lines.push(`stack: ${JSON.stringify(stack)}`);
  if (subprojects.length) {
    lines.push('subprojects:');
    for (const s of subprojects) {
      const key = /^[A-Za-z0-9_.-]+$/.test(s.name) ? s.name : JSON.stringify(s.name);
      lines.push(`  ${key}:`);
      lines.push(`    path: ${JSON.stringify(s.path)}`);
      lines.push(`    stages: [${s.stages.join(', ')}]`);
      if (s.stack) lines.push(`    stack: ${JSON.stringify(s.stack)}`);
      if (s.testCommand) lines.push(`    testCommand: ${JSON.stringify(s.testCommand)}`);
    }
  } else {
    lines.push('subprojects: {}');
  }
  lines.push('defaults:');
  lines.push(`  testCommand: ${JSON.stringify(rootTest || 'npm test')}`);
  lines.push('  reviewRequired: true');
  lines.push('');
  lines.push('# 模板来源：按 order 先到先得（团队 > 个人 > 上游），同名文件高优先库覆盖低优先库。');
  lines.push('# 上游始终作为兜底来源，不需要配置路径。');
  const order = Array.isArray(templates?.order) && templates.order.length
    ? templates.order
    : ['personal', 'upstream'];
  const team = templates?.team && typeof templates.team === 'object' ? templates.team : null;
  lines.push('templates:');
  lines.push(`  order: [${order.join(', ')}]`);
  lines.push('  personal:');
  lines.push(`    enabled: ${templates?.personal?.enabled !== false}`);
  if (team && (team.enabled !== undefined || team.repo || team.base || team.path)) {
    lines.push('  team:');
    if (team.enabled !== undefined) lines.push(`    enabled: ${team.enabled === true}`);
    if (team.repo) lines.push(`    repo: ${JSON.stringify(team.repo)}`);
    if (team.base) lines.push(`    base: ${JSON.stringify(team.base)}`);
    if (team.path) lines.push(`    path: ${JSON.stringify(team.path)}`);
  } else {
    lines.push('  # team:');
    lines.push('  #   enabled: true');
    lines.push('  #   repo: https://github.com/org/devflow-templates.git');
    lines.push('  #   path: ../devflow-templates');
  }
  lines.push('');
  lines.push('# 回灌时用于识别项目专属内容的关键词，命中则不回灌到插件模板。');
  lines.push('upstream:');
  lines.push(`  blocklist: ${JSON.stringify(Array.isArray(blocklist) ? blocklist : [])}`);
  return `${lines.join('\n')}\n`;
}

/** 按合并视图复制模板；已有文件默认不覆盖，草稿即使 --force 也不覆盖。 */
function copyTemplates(files, root, force) {
  let copied = 0;
  for (const file of files) {
    // 模板库草稿不是规则，不复制到项目，也不写入源文件账本。
    if (isDraft(readText(file.src))) continue;
    const dst = join(root, ...file.destRel.split('/'));
    if (existsSync(dst) && (!force || isDraft(readText(dst)))) continue;
    ensureDir(dirname(dst));
    copyFileSync(file.src, dst);
    copied += 1;
  }
  return copied;
}

/** 记录源文件基线，供 /devflow:sync 做三方合并。
 * 同时写入哈希账本和 `.claude/.hub-bases/` 快照：账本判断“本地是否手改”，
 * 快照作为 git merge-file 的 base，能自动合并双方都改过的文件。
 */
function writeSourceManifest(root, version, files) {
  const entries = {};
  for (const file of files) {
    const abs = join(root, ...file.destRel.split('/'));
    if (!existsSync(abs)) continue;
    const text = readText(abs);
    const hash = contentHash(text);
    if (hash !== contentHash(readText(file.src))) continue;
    entries[file.destRel] = { base: hash, local: hash, source: file.source };
    const baseFile = join(root, '.claude', '.hub-bases', ...file.hubRel.split('/'));
    ensureDir(dirname(baseFile));
    writeAtomic(baseFile, readText(file.src));
  }
  writeAtomic(join(root, '.claude', '.hub-sources.json'), `${JSON.stringify({
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    pluginVersion: version,
    files: entries,
  }, null, 2)}\n`);
}

const GITIGNORE_BLOCK = gitignoreBlock();

/** 用标记块替换而非追加，规则变更时可原地升级。 */
function upsertGitignore(root) {
  const file = join(root, '.gitignore');
  const current = existsSync(file) ? readText(file) : '';
  const pattern = /# >>> devflow[^\n]*\n[\s\S]*?# <<< devflow\n?/;
  const next = pattern.test(current)
    ? current.replace(pattern, GITIGNORE_BLOCK)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${GITIGNORE_BLOCK}`;
  if (next === current) return false;
  writeText(file, next);
  return true;
}

/** 写入前校验：词法上在项目内，且解析 junction/符号链接后仍在项目内。 */
function assertWritable(root, target, what) {
  if (!isPathInside(root, target) || !isRealPathInside(root, target)) {
    throw new Error(`${what} 越界（可能被 junction/符号链接引到项目外）：${posix(target)}`);
  }
}

/** 草稿是用户真源：已存在一律不覆盖，--force 也不覆盖。 */
function writeDrafts(root, drafts) {
  let written = 0;
  let preserved = 0;
  for (const draft of drafts) {
    const target = join(root, ...draft.rel.split('/'));
    if (existsSync(target)) {
      // 只有草稿才叫“保留草稿”；模板复制进来的正式规则不计入。
      if (isDraft(readText(target))) preserved += 1;
      continue;
    }
    if (!isPathInside(root, target) || !isRealPathInside(root, target)) {
      log('warn', `草稿路径越界，跳过：${draft.rel}`);
      continue;
    }
    ensureDir(dirname(target));
    if (!isRealPathInside(root, target)) {
      log('warn', `草稿路径越界，跳过：${draft.rel}`);
      continue;
    }
    writeAtomic(target, draft.content);
    written += 1;
  }
  return { written, preserved };
}

export async function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, [
    '--root', '--force', '--draft', '--no-draft', '--plugin-root', '--source-root',
    '--personal-library', '--team-library',
  ]);
  const root = resolve(argValue(argv, '--root', projectRoot()));
  const force = hasFlag(argv, '--force');
  const draft = hasFlag(argv, '--draft');
  const noDraft = hasFlag(argv, '--no-draft');
  if (draft && noDraft) throw new Error('--draft 与 --no-draft 不能同时使用');
  const pluginRoot = resolve(argValue(argv, '--plugin-root', pluginRootFromScript()));
  const info = pluginInfo(pluginRoot);
  const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
  assertWritable(root, join(root, '.claude', 'hub'), '.claude/hub');
  assertWritable(root, hubFile, 'hub.yaml');
  assertWritable(root, ecosystemPath(root), ECOSYSTEM_FILE);
  assertWritable(root, statePath(root), STATE_FILE);

  const previousMeta = readMeta(root) || {};
  // 只在首次初始化时探测：已初始化的项目不再反复提示安装。
  let packHints = [];
  const personalLibrary = argValue(argv, '--personal-library', null);
  const teamLibrary = argValue(argv, '--team-library', null);
  const sourceArg = argValue(argv, '--source-root', null);
  const sourceRoot = sourceArg ? resolve(sourceArg) : (previousMeta.pluginSourceRoot || null);
  if (sourceRoot && !isValidPluginRoot(sourceRoot)) {
    throw new Error(`--source-root 不是 devflow 插件目录：${posix(sourceRoot)}`);
  }

  if (existsSync(hubFile) && !force) {
    log('warn', `已经初始化：${posix(hubFile)}。使用 --force 覆盖 hub.yaml 与模板；升级模板请用 /devflow:sync。`);
    // 只补通用草稿，不推断栈：已有工作区应尊重用户当前的 stack 声明。
    if (!noDraft) {
      const rel = '.claude/hub/_shared/project-basics.md';
      const target = join(root, ...rel.split('/'));
      if (!existsSync(target)) {
        const { written } = writeDrafts(root, [{ rel, content: renderProjectBasicsDraft() }]);
        if (written) {
          log('ok', `补生成规则草稿 ${rel}`);
          log('info', draft
            ? '已按 --draft 生成草稿；通过 /devflow:init --draft 调用时由技能补全 TODO'
            : '草稿已生成；智能补全仅在 /devflow:init --draft 中执行');
        }
      }
    }
    if (!existsSync(join(root, OVERVIEW_FILE))) {
      try {
        generateOverview(root, { full: false });
        log('ok', `补生成项目概览 ${OVERVIEW_FILE}（运行 /devflow:onboard 深度重扫）`);
      } catch (err) {
        log('warn', `补生成项目概览失败：${err.message}`);
      }
    }
  } else {
    ensureDir(join(root, '.claude', 'hub', 'stages'));
    ensureDir(join(root, '.claude', 'hub', '_shared'));
    ensureDir(join(root, '.claude', 'hub', 'overrides'));
    ensureDir(join(root, '.claude', 'hub', 'stacks'));
    let existing = {};
    if (existsSync(hubFile)) {
      try {
        existing = parseYaml(readText(hubFile));
      } catch (err) {
        // --force 是配置损坏后的恢复入口：解析失败时不能直接退出。
        // 先备份原文件再按空配置重建，避免用户在无提示的情况下丢失配置。
        const backup = `${hubFile}.bak`;
        copyFileSync(hubFile, backup);
        log('warn', `无法解析 .claude/hub/hub.yaml（${err.message}），已备份到 .claude/hub/hub.yaml.bak 并重建`);
      }
    }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    const previousSubs = existing.subprojects && typeof existing.subprojects === 'object'
      && !Array.isArray(existing.subprojects)
      ? existing.subprojects
      : {};
    const previousStack = (sub) => {
      const own = previousSubs[sub.name];
      if (own?.stack) return String(own.stack);
      for (const value of Object.values(previousSubs)) {
        if (value?.path === sub.path && value?.stack) return String(value.stack);
      }
      return null;
    };
    const config = {
      ...existing,
      templates: existing.templates || { order: ['personal', 'upstream'], personal: { enabled: true } },
    };
    const libraries = resolveLibraries(root, config, {
      pluginRoot,
      personalLibrary,
      teamLibrary,
    });
    const templateFiles = collectTemplateFiles(libraries);
    const copied = copyTemplates(templateFiles, root, force);
    const { list: subs, expanded } = discoverSubprojects(root);
    packHints = detectPackHints(root, subs);
    const subsWithStack = subs.map((sub) => ({ ...sub, stack: previousStack(sub) }));
    const rootTest = detectTestCommand(root);
    const detected = noDraft ? { names: [], labels: [] } : detectWorkspaceStacks(root, subs);
    const autoStack = !noDraft && !existing.stack && detected.names.length === 1
      ? detected.names[0]
      : null;
    const stackForYaml = existing.stack ? String(existing.stack) : autoStack;
    writeAtomic(hubFile, renderHubYaml(subsWithStack, info.version, rootTest, {
      templates: config.templates,
      blocklist: existing.upstream?.blocklist,
      stack: stackForYaml,
    }));
    writeSourceManifest(root, info.version, templateFiles);
    if (noDraft) {
      log('ok', '跳过规则草稿生成（--no-draft）');
    } else {
      const { written, preserved } = writeDrafts(root, planDrafts({ detected, stackName: stackForYaml }));
      if (written) log('ok', `生成 ${written} 个规则草稿（TODO 是占位，不是规则）`);
      if (preserved) log('ok', `保留已有草稿 ${preserved} 个`);
      log('info', draft
        ? '已按 --draft 生成草稿；通过 /devflow:init --draft 调用时由技能补全 TODO'
        : '草稿已生成；智能补全仅在 /devflow:init --draft 中执行');
      if (autoStack) log('ok', `探测到单一技术栈 ${autoStack}，已写入 hub.yaml 的 stack`);
      else if (!existing.stack && detected.names.length > 1) {
        log('warn', `探测到多个技术栈（${detected.names.join('、')}），未自动声明 stack；可用 devflow-rule-placement 落位`);
      }
    }
    log('ok', `创建 ${posix(hubFile)}（${copied} 个阶段模板，${subs.length} 个子项目）`);
    if (expanded.length) {
      log('ok', `Maven 多模块已展开：${expanded.join('、')}。父 pom 不再单独成项，可按需调整。`);
    }
    if (!rootTest) log('warn', '未探测到根项目的测试命令，暂写 npm test，请按实际修改 defaults.testCommand');
    const missing = subs.filter((s) => s.stages.includes('test') && !s.testCommand);
    if (missing.length) log('warn', `以下子项目没有可探测的测试命令，请手动补充：${missing.map((s) => s.path).join('、')}`);
  }

  let eco = loadEcosystem(root);
  if (!eco.exists) {
    createDefaultConfig(root);
    eco = loadEcosystem(root);
    log('ok', `创建 ${ECOSYSTEM_FILE}（工具路由默认 ask）`);
  }
  if (eco.error) {
    log('warn', `${ECOSYSTEM_FILE} 解析失败，检测按默认目录进行：${eco.error}`);
  }
  const ecoState = writeDetectedState(root, eco.config);
  const available = Object.entries(ecoState.tools)
    .filter(([, value]) => value.available)
    .map(([id]) => id);
  log('ok', available.length
    ? `工具检测：${available.join('、')}（写入 ${STATE_FILE}）`
    : `工具检测：未发现已知工具（写入 ${STATE_FILE}）`);

  const metaFile = join(root, '.devflow.json');
  assertWritable(root, metaFile, '.devflow.json');
  writeAtomic(metaFile, `${JSON.stringify({
    ...previousMeta,
    pluginRoot,
    pluginVersion: info.version,
    ...(sourceRoot ? { pluginSourceRoot: sourceRoot } : {}),
    ...(personalLibrary ? { personalLibraryPath: resolve(personalLibrary) } : {}),
    ...(teamLibrary ? { teamLibraryPath: resolve(teamLibrary) } : {}),
    initializedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  log('ok', '记录插件位置 .devflow.json');

  const scriptsDir = join(root, 'scripts');
  assertWritable(root, scriptsDir, 'scripts/');
  ensureDir(scriptsDir);
  for (const [file, target] of Object.entries(LOADERS)) {
    const dst = join(scriptsDir, file);
    assertWritable(root, dst, `scripts/${file}`);
    const source = loaderSource(target);
    if (existsSync(dst) && !force) {
      // loader 是生成物：内容过旧时自动重写，避免插件升级后仍走旧回退顺序。
      if (normalizeEol(readText(dst)) === normalizeEol(source)) continue;
      writeText(dst, source);
      log('ok', `更新 scripts/${file}`);
      continue;
    }
    writeText(dst, source);
    log('ok', `写入 scripts/${file}`);
  }

  assertWritable(root, join(root, '.gitignore'), '.gitignore');
  if (upsertGitignore(root)) log('ok', '更新 .gitignore');
  else log('ok', '.gitignore 已包含 devflow 片段');

  const report = await generate(['--root', root]);

  // 概览指纹包含项目顶层目录：必须等 loader、投影与账本都写入后再生成，
  // 否则 init 自己创建的 scripts/ 会让刚写出的概览立刻显示为过期。
  try {
    generateOverview(root, { full: false });
    log('ok', '生成项目概览 .claude/hub/project-overview.md（运行 /devflow:onboard 深度重扫）');
  } catch (err) {
    log('warn', `生成项目概览失败：${err.message}`);
  }

  if (report.errors?.length) {
    log('warn', `初始化完成，但生成阶段有 ${report.errors.length} 个错误，请按上方提示处理。`);
  } else {
    log('ok', '初始化完成');
  }
  // 静态使用边界：不探测项目、不判断“适不适合”，只说明成本与替代入口。
  log('info', '使用边界：devflow 适合会持续维护、需要保留需求/计划/测试/评审记录的项目');
  log('info', 'demo、原型或一次性脚本直接用 Claude Code 更快；小功能用 /devflow:req --light，小 bug 用 /devflow:debug');
  console.log('\n下一步：');
  const nextSteps = ['直接开始：/devflow:req <需求>'];
  if (!noDraft) {
    nextSteps.push('（可选）填写 .claude/hub/_shared/project-basics.md 中的 TODO，并删除已填草稿首行的草稿标记');
    nextSteps.push('（可选）技术栈草稿在 .claude/hub/stacks/<stack>/；多栈或不确定放哪时用 devflow-rule-placement');
  }
  // 只在值看起来安全时回显：带 URL userinfo 或选项形态的值可能含凭据。
  const stackRepo = (process.env.DEVFLOW_STACK_REPO || '').trim();
  const safeStackRepo = stackRepo && !stackRepo.startsWith('-')
    && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/.test(stackRepo)
    ? stackRepo
    : null;
  const repoHint = safeStackRepo ? ` --repo ${safeStackRepo}` : ' --repo <仓库地址>';
  for (const hint of packHints) {
    nextSteps.push(`（可选）检测到 ${hint} 技术栈：devflow stack add ${hint}${repoHint}`);
  }
  nextSteps.push('（可选）node scripts/devflow-gen.mjs 刷新投影，node scripts/devflow-doctor.mjs 体检');
  nextSteps.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
  if (noDraft) {
    console.log('  （本次使用 --no-draft，没有生成规则草稿；去掉该参数重新运行 init 可生成）');
  }
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
