#!/usr/bin/env node
import { existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, readText, writeText, writeAtomic, pluginInfo, argValue, hasFlag,
  log, posix, isMain, projectRoot,
} from './lib/common.mjs';
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

function discoverSubprojects(root) {
  const found = [];
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      const rel = relative(root, child).split(sep).join('/');
      if (isProjectDir(child)) {
        const looksDemand = /demand|require|design|spec|doc/i.test(entry.name);
        found.push({
          name: entry.name,
          path: rel,
          stages: looksDemand ? ['req'] : ['plan', 'implement', 'test', 'review', 'debug'],
          testCommand: looksDemand ? null : commandFromRoot(root, child, detectTestCommand(child, root)),
        });
      } else if (depth < 2) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 1);

  found.sort((a, b) => a.path.localeCompare(b.path));

  const seen = new Map();
  for (const s of found) seen.set(s.name, (seen.get(s.name) || 0) + 1);
  for (const s of found) {
    if (seen.get(s.name) > 1) s.name = s.path.replace(/\//g, '-');
  }
  return found;
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

function loaderSource(name) {
  return `#!/usr/bin/env node
// devflow 薄 loader：真实实现在插件内，避免项目里出现第二份脚本。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(root, '.devflow.json'), 'utf8'));
const mod = await import(pathToFileURL(join(meta.pluginRoot, 'scripts', '${name}.mjs')).href);
await mod.main(process.argv.slice(2));
`;
}

function copyTree(src, dst, overwrite) {
  let copied = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
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

const GITIGNORE_BLOCK = `# >>> devflow (generated, do not commit)
.claude/skills/devflow-*/
.claude/.hub-manifest.json
.claude/.devflow-state.json
.devflow.json
# <<< devflow
`;

function appendGitignore(root) {
  const file = join(root, '.gitignore');
  const current = existsSync(file) ? readText(file) : '';
  if (current.includes('# >>> devflow')) return false;
  writeText(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${GITIGNORE_BLOCK}`);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const root = resolve(argValue(argv, '--root', projectRoot()));
  const force = hasFlag(argv, '--force');
  const pluginRoot = argValue(argv, '--plugin-root', pluginRootFromScript());
  const info = pluginInfo(pluginRoot);
  const hubFile = join(root, '.claude', 'hub', 'hub.yaml');

  if (existsSync(hubFile) && !force) {
    log('warn', `已经初始化：${posix(hubFile)}。使用 --force 覆盖 hub.yaml 与模板。`);
  } else {
    ensureDir(join(root, '.claude', 'hub', 'stages'));
    ensureDir(join(root, '.claude', 'hub', '_shared'));
    ensureDir(join(root, '.claude', 'hub', 'overrides'));
    const copied = copyStageTemplates(pluginRoot, root, force);
    const subs = discoverSubprojects(root);
    const rootTest = detectTestCommand(root);
    writeAtomic(hubFile, renderHubYaml(subs, info.version, rootTest));
    log('ok', `创建 ${posix(hubFile)}（${copied} 个阶段模板，${subs.length} 个子项目）`);
    if (!rootTest) log('warn', '未探测到根项目的测试命令，暂写 npm test，请按实际修改 defaults.testCommand');
    const missing = subs.filter((s) => s.stages.includes('test') && !s.testCommand);
    if (missing.length) log('warn', `以下子项目没有可探测的测试命令，请手动补充：${missing.map((s) => s.path).join('、')}`);
  }

  const metaFile = join(root, '.devflow.json');
  writeAtomic(metaFile, `${JSON.stringify({
    pluginRoot,
    pluginVersion: info.version,
    initializedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  log('ok', '记录插件位置 .devflow.json');

  const scriptsDir = join(root, 'scripts');
  ensureDir(scriptsDir);
  const loaders = {
    'devflow-gen.mjs': 'gen-claude-skills',
    'devflow-doctor.mjs': 'hub-doctor',
    'devflow-upstream.mjs': 'hub-upstream',
    'devflow-test.mjs': 'mark-test',
  };
  for (const [file, target] of Object.entries(loaders)) {
    const dst = join(scriptsDir, file);
    if (existsSync(dst) && !force) continue;
    writeText(dst, loaderSource(target));
    log('ok', `写入 scripts/${file}`);
  }

  if (appendGitignore(root)) log('ok', '更新 .gitignore');
  else log('ok', '.gitignore 已包含 devflow 片段');

  const report = await generate(['--root', root]);
  log('ok', '初始化完成');
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
