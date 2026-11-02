import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readText, writeAtomic, ensureDir, loadHub, isPathInside, isRealPathInside, normalizeEol } from './common.mjs';

export const OVERVIEW_FILE = '.claude/hub/project-overview.md';
export const AUTO_START = '<!-- devflow:auto:start -->';
export const AUTO_END = '<!-- devflow:auto:end -->';

const SKIP_TOP = new Set(['.git', '.claude', 'node_modules', 'dist', 'build', 'target', 'coverage']);

const BUILD_FILES = [
  ['package.json', 'Node.js'],
  ['pom.xml', 'Java / Maven'],
  ['build.gradle', 'Java / Gradle'],
  ['settings.gradle', 'Java / Gradle'],
  ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'],
  ['pyproject.toml', 'Python'],
  ['pytest.ini', 'Python / pytest'],
  ['requirements.txt', 'Python'],
  ['Gemfile', 'Ruby'],
  ['composer.json', 'PHP'],
  ['Makefile', 'Make'],
];

const ENTRY_CANDIDATES = [
  'src/index.js', 'src/main.js', 'src/app.js', 'index.js', 'main.js', 'app.js',
  'src/index.ts', 'src/main.ts', 'src/app.ts',
  'main.go', 'src/main.rs', 'src/lib.rs',
  'src/main/java', 'Program.cs', 'manage.py', 'app.py', 'main.py',
];

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function scanFacts(root, { full = true, subprojectPaths = [] } = {}) {
  const techStack = [];
  const seen = new Set();
  for (const rel of ['.', ...subprojectPaths]) {
    const dir = resolve(root, rel);
    if (!isPathInside(root, dir)) continue;
    for (const [file, label] of BUILD_FILES) {
      if (!existsSync(join(dir, file))) continue;
      const tag = rel === '.'
        ? `${label}（${file}）`
        : `${label}（${String(rel).replace(/\\/g, '/')}/${file}）`;
      if (!seen.has(tag)) {
        seen.add(tag);
        techStack.push(tag);
      }
    }
  }
  const topDirs = safeReaddir(root)
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_TOP.has(e.name))
    .map((e) => e.name)
    .sort();
  const entrypoints = full
    ? ENTRY_CANDIDATES.filter((p) => {
      try { return statSync(join(root, p)).isFile(); } catch { return false; }
    })
    : [];
  const workflows = join(root, '.github', 'workflows');
  const ci = full && existsSync(workflows)
    ? safeReaddir(workflows).filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name)).map((e) => e.name).sort()
    : [];
  return { techStack, topDirs, entrypoints, ci };
}

export function readHubFacts(root) {
  const { config } = loadHub(root);
  const raw = config.subprojects;
  const subprojects = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.entries(raw).map(([name, value]) => ({
      name,
      path: value?.path || name,
      testCommand: value?.testCommand || null,
    }))
    : [];
  return { subprojects, rootTest: config.defaults?.testCommand || null };
}

export function buildAutoSection({ facts, subprojects, rootTest, now, full }) {
  const lines = [
    AUTO_START,
    `> 本节由 devflow 自动生成（${now}），运行 \`/devflow:onboard\` 重扫会刷新，请勿手改。`,
    '',
    '### 技术栈',
    ...(facts.techStack.length ? facts.techStack.map((t) => `- ${t}`) : ['- 未识别到常见构建文件']),
    '',
    '### 子项目与测试命令',
    ...(subprojects.length
      ? subprojects.map((s) => `- \`${s.path}\`${s.testCommand ? ` → \`${s.testCommand}\`` : ' → 未探测到测试命令'}`)
      : ['- 单项目（无子项目）']),
    `- 根目录测试：${rootTest ? `\`${rootTest}\`` : '未探测到'}`,
    '',
    '### 顶层目录',
    ...(facts.topDirs.length ? facts.topDirs.map((d) => `- \`${d}/\``) : ['- 无']),
  ];
  if (full) {
    lines.push(
      '',
      '### 关键入口',
      ...(facts.entrypoints.length ? facts.entrypoints.map((p) => `- \`${p}\``) : ['- 未识别到常见入口文件']),
      '',
      '### GitHub Actions',
      ...(facts.ci.length ? facts.ci.map((f) => `- \`.github/workflows/${f}\``) : ['- 未发现 GitHub Actions 工作流']),
      '',
      '### 待确认',
      '- 以上基于目录与构建文件的启发式结果，请结合代码核对；未识别的技术栈补充到“项目补充”。',
    );
  }
  lines.push(AUTO_END);
  return lines.join('\n');
}

const AUTO_RE = new RegExp(
  `${AUTO_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${AUTO_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
);

// 时间戳只表示扫描时间，不参与“内容是否变化”的判断。
const STAMP_RE = /^> 本节由 devflow 自动生成（[^）]*）/m;
function withoutStamp(text) {
  return text.replace(STAMP_RE, '> 本节由 devflow 自动生成（STAMP）');
}

export function upsertAutoBlock(current, block) {
  if (!current) {
    return `${block}\n\n## 项目补充\n\n（在此记录业务背景、领域术语与阅读顺序。重扫不会覆盖本节。）\n`;
  }
  const starts = current.split(AUTO_START).length - 1;
  const ends = current.split(AUTO_END).length - 1;
  if (starts === 1 && ends === 1 && AUTO_RE.test(current)) return current.replace(AUTO_RE, block);
  if (starts || ends) {
    // 标记不成对时无法可靠区分自动段与人工段：只移除标记本身，保留其余文本，再前置新块。
    const cleaned = current.split(AUTO_START).join('').split(AUTO_END).join('');
    return `${block}\n\n${cleaned.trimStart()}`;
  }
  return `${block}\n\n${current}`;
}

export function generateOverview(root, { full = true, now = new Date().toISOString(), write = true } = {}) {
  const hub = readHubFacts(root);
  const facts = scanFacts(root, { full, subprojectPaths: hub.subprojects.map((s) => s.path) });
  const block = buildAutoSection({ facts, subprojects: hub.subprojects, rootTest: hub.rootTest, now, full });
  const hubDir = join(root, '.claude', 'hub');
  const file = join(root, OVERVIEW_FILE);
  if (write && (!isPathInside(root, hubDir) || !isRealPathInside(root, hubDir)
    || !isPathInside(root, file) || !isRealPathInside(root, file))) {
    throw new Error(`.claude/hub 越界（可能被 junction/符号链接引到项目外）：${hubDir}`);
  }
  const raw = existsSync(file) ? readText(file) : '';
  const current = normalizeEol(raw);
  const next = upsertAutoBlock(current, block);
  const changed = withoutStamp(next) !== withoutStamp(current);
  if (write && changed) {
    ensureDir(hubDir);
    writeAtomic(file, next);
  }
  return {
    file,
    content: write && !changed ? raw : next,
    changed,
    facts,
    subprojects: hub.subprojects,
  };
}
