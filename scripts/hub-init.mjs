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

const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];
const SKIP_DIRS = new Set(['.git', '.claude', '.idea', '.vscode', 'node_modules', 'dist', 'build', 'target', 'scripts', 'templates', 'docs', 'coverage']);

function pluginRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function detectPackageManager(dir, root = dir) {
  let cur = resolve(dir);
  const stop = resolve(root);
  while (true) {
    const pkg = join(cur, 'package.json');
    if (existsSync(pkg)) {
      try {
        const data = JSON.parse(readText(pkg));
        const m = /^(npm|pnpm|yarn|bun)@/.exec(String(data.packageManager || ''));
        if (m) return m[1];
      } catch { /* ignore */ }
    }
    if (existsSync(join(cur, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(cur, 'yarn.lock'))) return 'yarn';
    if (existsSync(join(cur, 'bun.lockb')) || existsSync(join(cur, 'bun.lock'))) return 'bun';
    const parent = dirname(cur);
    if (cur === stop || parent === cur) break;
    cur = parent;
  }
  return 'npm';
}

function detectTestCommand(dir, root = dir) {
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const data = JSON.parse(readText(pkg));
      if (data.scripts?.test) return `${detectPackageManager(dir, root)} run test`;
    } catch { /* ignore */ }
  }
  if (existsSync(join(dir, 'pom.xml'))) return 'mvn test';
  if (existsSync(join(dir, 'gradlew'))) return './gradlew test';
  if (existsSync(join(dir, 'gradlew.bat'))) return 'gradlew.bat test';
  if (existsSync(join(dir, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(dir, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'pytest.ini'))) return 'pytest';
  return null;
}

/** 子项目命令从工作区根执行，避免只跑根项目的测试。 */
function commandFromRoot(root, dir, command) {
  if (!command) return null;
  const rel = relative(root, dir).split(sep).join('/');
  if (!rel || rel === '.') return command;
  const arg = /^[A-Za-z0-9_./-]+$/.test(rel) ? rel : JSON.stringify(rel);
  return `cd ${arg} && ${command}`;
}

function isProjectDir(dir) {
  return existsSync(join(dir, '.git'))
    || existsSync(join(dir, 'package.json'))
    || existsSync(join(dir, 'pom.xml'))
    || existsSync(join(dir, 'build.gradle'))
    || existsSync(join(dir, 'go.mod'))
    || existsSync(join(dir, 'Cargo.toml'))
    || existsSync(join(dir, 'pyproject.toml'));
}

function readMavenModules(dir) {
  const pom = join(dir, 'pom.xml');
  if (!existsSync(pom)) return [];
  const block = /<modules>([\s\S]*?)<\/modules>/.exec(readText(pom));
  if (!block) return [];
  return [...block[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)]
    .map((m) => m[1].replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
}

/** 父 pom 聚合的模块单独成为子项目；比父级的 mvn test 粒度更细，也便于逐模块跑测试。 */
function expandMavenModules(root, dir, depth = 0) {
  if (depth > 2) return [];
  const out = [];
  for (const mod of readMavenModules(dir)) {
    const modDir = resolve(dir, mod);
    // <module> 可写成 ../x 或绝对路径；只接受工作区内的真实路径。
    if (!isPathInside(root, modDir) || !isRealPathInside(root, modDir)) continue;
    if (!existsSync(modDir)) continue;
    const rel = relative(root, modDir).split(sep).join('/');
    const nested = expandMavenModules(root, modDir, depth + 1);
    if (nested.length) {
      out.push(...nested);
    } else {
      out.push({
        name: basename(modDir),
        path: rel,
        stages: ['plan', 'implement', 'test', 'review', 'debug'],
        testCommand: commandFromRoot(root, modDir, detectTestCommand(modDir, root) || 'mvn test'),
      });
    }
  }
  return out;
}

function discoverSubprojects(root) {
  const found = [];
  const seen = new Set();
  const expanded = [];
  const push = (item) => {
    if (seen.has(item.path)) return;
    seen.add(item.path);
    found.push(item);
  };

  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      const rel = relative(root, child).split(sep).join('/');
      if (isProjectDir(child)) {
        // 只把 demand/require/design/spec/doc 这类目录整体当作需求来源；docker 等名字不能被误判。
        const looksDemand = /(^|[-_])(demand|requirements?|design|specs?|docs?)([-_.]|$)/i.test(entry.name);
        const modules = looksDemand ? [] : expandMavenModules(root, child);
        if (modules.length) {
          expanded.push(`${rel}（${modules.length} 个 Maven 模块）`);
          for (const mod of modules) push(mod);
        } else {
          push({
            name: entry.name,
            path: rel,
            stages: looksDemand ? ['req'] : ['plan', 'implement', 'test', 'review', 'debug'],
            testCommand: looksDemand ? null : commandFromRoot(root, child, detectTestCommand(child, root)),
          });
        }
      } else if (depth < 2) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 1);

  found.sort((a, b) => a.path.localeCompare(b.path));

  const counts = new Map();
  for (const s of found) counts.set(s.name, (counts.get(s.name) || 0) + 1);
  for (const s of found) {
    if (counts.get(s.name) > 1) s.name = s.path.replace(/\//g, '-');
  }
  return { list: found, expanded };
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

function copyStageTemplates(pluginRoot, root, force) {
  let copied = 0;
  for (const stage of STAGES) {
    const srcDir = join(pluginRoot, 'templates', 'stages', stage);
    const dstDir = join(root, '.claude', 'hub', 'stages', stage);
    if (!existsSync(srcDir)) continue;
    ensureDir(dstDir);
    copied += copyTree(srcDir, dstDir, force);
  }
  return copied;
}

/** 记录阶段源文件哈希，供 /devflow:sync 判断本地是否手改过。
 * 只记录“内容仍等于插件模板”的文件；初始化时因已存在而跳过的文件若已被手改，
 * 不能当作基线，否则 sync 会把本地改动误判成模板更新。
 */
function writeSourceManifest(root, version, pluginRoot) {
  const hubDir = join(root, '.claude', 'hub');
  const files = {};
  for (const abs of walk(join(hubDir, 'stages'))) {
    const rel = relPosix(hubDir, abs);
    if (isGeneratedArtifact(rel)) continue;
    const tpl = join(pluginRoot, 'templates', ...rel.split('/'));
    if (!existsSync(tpl)) continue;
    const hash = contentHash(readText(abs));
    if (hash !== contentHash(readText(tpl))) continue;
    files[`.claude/hub/${rel}`] = hash;
  }
  writeAtomic(join(root, '.claude', '.hub-sources.json'), `${JSON.stringify({
    schemaVersion: 1,
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
.claude/skills/devflow-*/
.claude/.hub-manifest.json
.claude/.hub-sources.json
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
