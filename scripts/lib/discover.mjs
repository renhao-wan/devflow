import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { readText, isPathInside, isRealPathInside } from './common.mjs';

export const SKIP_DIRS = new Set(['.git', '.claude', '.idea', '.vscode', 'node_modules', 'dist', 'build', 'target', 'scripts', 'templates', 'docs', 'coverage']);

/** 构建文件与项目标记的唯一来源：子项目发现、技术栈识别共用。project 表示可作为子项目根。 */
export const BUILD_SIGNATURES = [
  { file: 'package.json', label: 'Node.js', project: true },
  { file: 'pom.xml', label: 'Java / Maven', project: true },
  { file: 'build.gradle', label: 'Java / Gradle', project: true },
  { file: 'settings.gradle', label: 'Java / Gradle' },
  { file: 'go.mod', label: 'Go', project: true },
  { file: 'Cargo.toml', label: 'Rust', project: true },
  { file: 'pyproject.toml', label: 'Python', project: true },
  { file: 'pytest.ini', label: 'Python / pytest' },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'Gemfile', label: 'Ruby' },
  { file: 'composer.json', label: 'PHP' },
  { file: 'Makefile', label: 'Make' },
];

/** 目录内命中的构建文件，按 BUILD_SIGNATURES 顺序返回。 */
export function detectTechStack(dir) {
  return BUILD_SIGNATURES
    .filter(({ file }) => existsSync(join(dir, file)))
    .map(({ file, label }) => ({ file, label }));
}

export function detectPackageManager(dir, root = dir) {
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

export function detectTestCommand(dir, root = dir) {
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
export function commandFromRoot(root, dir, command) {
  if (!command) return null;
  const rel = relative(root, dir).split(sep).join('/');
  if (!rel || rel === '.') return command;
  const arg = /^[A-Za-z0-9_./-]+$/.test(rel) ? rel : JSON.stringify(rel);
  return `cd ${arg} && ${command}`;
}

export function isProjectDir(dir) {
  if (existsSync(join(dir, '.git'))) return true;
  return BUILD_SIGNATURES.some((s) => s.project && existsSync(join(dir, s.file)));
}

export function readMavenModules(dir) {
  const pom = join(dir, 'pom.xml');
  if (!existsSync(pom)) return [];
  const block = /<modules>([\s\S]*?)<\/modules>/.exec(readText(pom));
  if (!block) return [];
  return [...block[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)]
    .map((m) => m[1].replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
}

/** 父 pom 聚合的模块单独成为子项目；比父级的 mvn test 粒度更细，也便于逐模块跑测试。 */
export function expandMavenModules(root, dir, depth = 0) {
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

export function discoverSubprojects(root) {
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

export function detectFrameworks(dir) {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return [];
  try {
    const data = JSON.parse(readText(pkg));
    const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) };
    // 只认 Vue 3：Vue 2 的规范差异大，误报会诱导安装错误的包。
    // 取声明范围的主版本判断，拒绝 >=2.6.0 <3.0.0 这类含 3 的 Vue 2 区间。
    const vue = deps.vue;
    if (typeof vue === 'string' && /^(?:npm:vue@)?\s*[~^<>=]*\s*3(?:\.|$)/.test(vue)) return ['vue3'];
    return [];
  } catch {
    return [];
  }
}

export function detectPackHints(root, subs = []) {
  const dirs = [root, ...subs.map((sub) => join(root, ...String(sub?.path || sub?.name || '.').split('/')))];
  const hints = [];
  for (const dir of dirs) {
    if (existsSync(join(dir, 'pom.xml')) || existsSync(join(dir, 'build.gradle'))) {
      if (!hints.includes('java-spring')) hints.push('java-spring');
    }
    if (detectFrameworks(dir).includes('vue3') && !hints.includes('vue3')) hints.push('vue3');
  }
  return hints;
}
