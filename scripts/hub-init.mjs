#!/usr/bin/env node
import { existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, readText, writeText, writeAtomic, pluginInfo, argValue, hasFlag,
  log, posix, isMain, projectRoot, readMeta, isValidPluginRoot, contentHash, normalizeEol,
  walk, relPosix, isGeneratedArtifact, isPathInside, isRealPathInside,
} from './lib/common.mjs';
import {
  ECOSYSTEM_FILE, STATE_FILE, createDefaultConfig, loadEcosystem, writeDetectedState,
  ecosystemPath, statePath,
} from './lib/ecosystem.mjs';
import { main as generate } from './gen-claude-skills.mjs';
import { discoverSubprojects, detectTestCommand } from './lib/discover.mjs';
import { generateOverview, OVERVIEW_FILE } from './lib/overview.mjs';

const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

function pluginRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function renderHubYaml(subprojects, version, rootTest) {
  const lines = [
    '# devflow 项目真源配置。可以自由修改，改完运行 node scripts/devflow-gen.mjs。',
    'version: 1',
    `requiresPlugin: "^${version}"`,
    'stages:',
    ...STAGES.map((s) => `  - ${s}`),
  ];
  if (subprojects.length) {
    lines.push('subprojects:');
    for (const s of subprojects) {
      const key = /^[A-Za-z0-9_.-]+$/.test(s.name) ? s.name : JSON.stringify(s.name);
      lines.push(`  ${key}:`);
      lines.push(`    path: ${JSON.stringify(s.path)}`);
      lines.push(`    stages: [${s.stages.join(', ')}]`);
      if (s.testCommand) lines.push(`    testCommand: ${JSON.stringify(s.testCommand)}`);
    }
  } else {
    lines.push('subprojects: {}');
  }
  lines.push('defaults:');
  lines.push(`  testCommand: ${JSON.stringify(rootTest || 'npm test')}`);
  lines.push('  reviewRequired: true');
  lines.push('');
  lines.push('# 回灌时用于识别项目专属内容的关键词，命中则不回灌到插件模板。');
  lines.push('upstream:');
  lines.push('  blocklist: []');
  return `${lines.join('\n')}\n`;
}

export const LOADERS = {
  'devflow-gen.mjs': 'gen-claude-skills',
  'devflow-doctor.mjs': 'hub-doctor',
  'devflow-route.mjs': 'hub-route',
  'devflow-upstream.mjs': 'hub-upstream',
  'devflow-test.mjs': 'mark-test',
  'devflow-triage.mjs': 'review-triage',
};

export function loaderSource(name) {
  return `#!/usr/bin/env node
// devflow 薄 loader：真实实现在插件内，避免项目里出现第二份脚本。
// 插件升级后 .devflow.json 记录的旧缓存可能失效，此时优先使用当前会话的 CLAUDE_PLUGIN_ROOT，再回退到源码仓库。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let meta = {};
try { meta = JSON.parse(readFileSync(join(root, '.devflow.json'), 'utf8')); } catch { meta = {}; }

const candidates = [process.env.CLAUDE_PLUGIN_ROOT, meta.pluginRoot, meta.pluginSourceRoot]
  .filter(Boolean)
  .filter((dir, i, all) => all.indexOf(dir) === i);
let mod = null;
let lastError = null;
for (const dir of candidates) {
  const entry = join(dir, 'scripts', '${name}.mjs');
  if (!existsSync(entry)) { lastError = new Error('缺少 ' + entry); continue; }
  try {
    mod = await import(pathToFileURL(entry).href);
    break;
  } catch (err) { lastError = err; }
}
if (!mod) {
  console.error('[ERR] 找不到可用的 devflow 插件目录。请检查 CLAUDE_PLUGIN_ROOT，或重新运行 /devflow:init。'
    + (lastError ? ' 最后一次错误：' + lastError.message : ''));
  process.exit(1);
}
await mod.main(process.argv.slice(2));
`;
}

function copyTree(src, dst, overwrite) {
  let copied = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isGeneratedArtifact(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      ensureDir(to);
      copied += copyTree(from, to, overwrite);
    } else if (entry.isFile()) {
      if (existsSync(to) && !overwrite) continue;
      copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

const TEMPLATE_ROOTS = [
  { src: 'templates/stages', dest: 'stages' },
  { src: 'templates/shared', dest: '_shared' },
];

function copyStageTemplates(pluginRoot, root, force) {
  let copied = 0;
  for (const def of TEMPLATE_ROOTS) {
    const srcDir = join(pluginRoot, ...def.src.split('/'));
    const dstDir = join(root, '.claude', 'hub', def.dest);
    if (!existsSync(srcDir)) continue;
    ensureDir(dstDir);
    copied += copyTree(srcDir, dstDir, force);
  }
  return copied;
}

/** 记录源文件基线，供 /devflow:sync 做三方合并。
 * 同时写入哈希账本和 `.claude/.hub-bases/` 快照：账本判断“本地是否手改”，
 * 快照作为 git merge-file 的 base，能自动合并双方都改过的文件。
 */
function writeSourceManifest(root, version, pluginRoot) {
  const hubRoot = join(root, '.claude', 'hub');
  const files = {};
  for (const def of TEMPLATE_ROOTS) {
    const hubDir = join(hubRoot, def.dest);
    const tplDir = join(pluginRoot, ...def.src.split('/'));
    if (!existsSync(hubDir)) continue;
    for (const abs of walk(hubDir)) {
      const rel = relPosix(hubDir, abs);
      if (isGeneratedArtifact(rel)) continue;
      const tpl = join(tplDir, ...rel.split('/'));
      if (!existsSync(tpl)) continue;
      const text = readText(abs);
      const hash = contentHash(text);
      if (hash !== contentHash(readText(tpl))) continue;
      const destRel = `.claude/hub/${def.dest}/${rel}`;
      files[destRel] = { base: hash, local: hash };
      const baseFile = join(root, '.claude', '.hub-bases', def.dest, ...rel.split('/'));
      ensureDir(dirname(baseFile));
      writeAtomic(baseFile, readText(tpl));
    }
  }
  writeAtomic(join(root, '.claude', '.hub-sources.json'), `${JSON.stringify({
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    pluginVersion: version,
    files,
  }, null, 2)}\n`);
}

const GITIGNORE_BLOCK = `# >>> devflow (generated, do not commit)
scripts/devflow-gen.mjs
scripts/devflow-doctor.mjs
scripts/devflow-route.mjs
scripts/devflow-upstream.mjs
scripts/devflow-test.mjs
scripts/devflow-triage.mjs
.claude/skills/devflow-*/
.claude/.hub-manifest.json
.claude/.hub-sources.json
.claude/.hub-bases/
.claude/.devflow-state.json
.claude/.ecosystem-state.json
.devflow.json
# <<< devflow
`;

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

export async function main(argv = process.argv.slice(2)) {
  const root = resolve(argValue(argv, '--root', projectRoot()));
  const force = hasFlag(argv, '--force');
  const pluginRoot = resolve(argValue(argv, '--plugin-root', pluginRootFromScript()));
  const info = pluginInfo(pluginRoot);
  const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
  assertWritable(root, join(root, '.claude', 'hub'), '.claude/hub');
  assertWritable(root, hubFile, 'hub.yaml');
  assertWritable(root, ecosystemPath(root), ECOSYSTEM_FILE);
  assertWritable(root, statePath(root), STATE_FILE);

  const previousMeta = readMeta(root) || {};
  const sourceArg = argValue(argv, '--source-root', null);
  const sourceRoot = sourceArg ? resolve(sourceArg) : (previousMeta.pluginSourceRoot || null);
  if (sourceRoot && !isValidPluginRoot(sourceRoot)) {
    throw new Error(`--source-root 不是 devflow 插件目录：${posix(sourceRoot)}`);
  }

  if (existsSync(hubFile) && !force) {
    log('warn', `已经初始化：${posix(hubFile)}。使用 --force 覆盖 hub.yaml 与模板；升级模板请用 /devflow:sync。`);
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
    const copied = copyStageTemplates(pluginRoot, root, force);
    const { list: subs, expanded } = discoverSubprojects(root);
    const rootTest = detectTestCommand(root);
    writeAtomic(hubFile, renderHubYaml(subs, info.version, rootTest));
    writeSourceManifest(root, info.version, pluginRoot);
    log('ok', `创建 ${posix(hubFile)}（${copied} 个阶段模板，${subs.length} 个子项目）`);
    try {
      generateOverview(root, { full: false });
      log('ok', '生成项目概览 .claude/hub/project-overview.md（运行 /devflow:onboard 深度重扫）');
    } catch (err) {
      log('warn', `生成项目概览失败：${err.message}`);
    }
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
    pluginRoot,
    pluginVersion: info.version,
    ...(sourceRoot ? { pluginSourceRoot: sourceRoot } : {}),
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
  if (report.errors?.length) {
    log('warn', `初始化完成，但生成阶段有 ${report.errors.length} 个错误，请按上方提示处理。`);
  } else {
    log('ok', '初始化完成');
  }
  console.log('\n下一步：');
  console.log('  1. 编辑 .claude/hub/hub.yaml（子项目、测试命令）');
  console.log('  2. 编辑 .claude/hub/stages/*/SKILL.md（项目规范）');
  console.log('  3. node scripts/devflow-gen.mjs');
  console.log('  4. node scripts/devflow-doctor.mjs');
  return report;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
