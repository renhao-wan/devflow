import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { readText, writeAtomic, ensureDir, loadHub, isPathInside, isRealPathInside, normalizeEol, sha256 } from './common.mjs';
import { detectTechStack } from './discover.mjs';

export const OVERVIEW_FILE = '.claude/hub/project-overview.md';
export const AUTO_START = '<!-- devflow:auto:start -->';
export const AUTO_END = '<!-- devflow:auto:end -->';
const FACTS_RE = /^<!-- devflow:facts:([a-f0-9]{64}) -->$/m;

const SKIP_TOP = new Set(['.git', '.claude', 'node_modules', 'dist', 'build', 'target', 'coverage']);

const ENTRY_CANDIDATES = [
  'src/index.js', 'src/main.js', 'src/app.js', 'index.js', 'main.js', 'app.js',
  'src/index.ts', 'src/main.ts', 'src/app.ts',
  'main.go', 'src/main.rs', 'src/lib.rs',
  'Program.cs', 'manage.py', 'app.py', 'main.py',
];
const ENTRY_LIMIT = 50;
const JAVA_ENTRY_RE = /(Application|Main)\.java$/;

function safeReaddir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function findJavaEntries(dir, maxDepth = 8) {
  const out = [];
  let visited = 0;
  const visit = (cur, depth) => {
    if (depth > maxDepth || out.length >= ENTRY_LIMIT || visited >= 2000) return;
    for (const entry of safeReaddir(cur)) {
      if (out.length >= ENTRY_LIMIT || visited >= 2000) return;
      visited += 1;
      if (entry.isSymbolicLink()) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (JAVA_ENTRY_RE.test(entry.name)) out.push(full);
    }
  };
  visit(dir, 0);
  return out;
}

/** 在根与各子项目内启发式定位入口；输出相对项目根的 POSIX 路径。 */
export function scanEntrypoints(root, dirs = ['.']) {
  const out = [];
  const seen = new Set();
  const add = (abs) => {
    if (out.length >= ENTRY_LIMIT) return;
    const rel = relative(root, abs);
    if (isAbsolute(rel) || !rel || rel === '.') return;
    const posix = rel.split(sep).join('/');
    if (posix.startsWith('../') || seen.has(posix)) return;
    seen.add(posix);
    out.push(posix);
  };
  for (const relDir of new Set(dirs)) {
    const dir = resolve(root, relDir);
    if (!isPathInside(root, dir)) continue;
    for (const candidate of ENTRY_CANDIDATES) {
      const abs = join(dir, candidate);
      try { if (statSync(abs).isFile()) add(abs); } catch { /* 不存在 */ }
    }
    const cmdDir = join(dir, 'cmd');
    for (const entry of safeReaddir(cmdDir)) {
      if (!entry.isDirectory()) continue;
      const abs = join(cmdDir, entry.name, 'main.go');
      try { if (statSync(abs).isFile()) add(abs); } catch { /* 不存在 */ }
    }
    for (const abs of findJavaEntries(join(dir, 'src', 'main', 'java'))) add(abs);
  }
  return out.sort();
}

/** 行内代码：围栏比内容中最长的反引号多一个，避免值里的反引号截断 Markdown。 */
function codeSpan(value) {
  const s = String(value).replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...(s.match(/`+/g) || []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

export function scanFacts(root, { subprojectPaths = [] } = {}) {
  const techStack = [];
  const seen = new Set();
  for (const rel of ['.', ...new Set(subprojectPaths)]) {
    const dir = resolve(root, rel);
    if (!isPathInside(root, dir)) continue;
    for (const { file, label } of detectTechStack(dir)) {
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
  const entrypoints = scanEntrypoints(root, ['.', ...subprojectPaths]);
  const workflows = join(root, '.github', 'workflows');
  const ci = existsSync(workflows)
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

export function buildAutoSection({ facts, subprojects, rootTest, now, full, fingerprint }) {
  const lines = [
    AUTO_START,
    `> 本节由 devflow 自动生成（${now}），运行 \`/devflow:onboard\` 重扫会刷新，请勿手改。`,
    `<!-- devflow:facts:${fingerprint} -->`,
    '',
    '### 技术栈',
    ...(facts.techStack.length ? facts.techStack.map((t) => `- ${t}`) : ['- 未识别到常见构建文件']),
    '',
    '### 子项目与测试命令',
    ...(subprojects.length
      ? subprojects.map((s) => `- ${codeSpan(s.path)}${s.testCommand ? ` → ${codeSpan(s.testCommand)}` : ' → 未探测到测试命令'}`)
      : ['- 单项目（无子项目）']),
    `- 根目录测试：${rootTest ? codeSpan(rootTest) : '未探测到'}`,
    '',
    '### 顶层目录',
    ...(facts.topDirs.length ? facts.topDirs.map((d) => `- ${codeSpan(`${d}/`)}`) : ['- 无']),
  ];
  if (full) {
    lines.push(
      '',
      '### 关键入口',
      ...(facts.entrypoints.length ? facts.entrypoints.map((p) => `- ${codeSpan(p)}`) : ['- 未识别到常见入口文件']),
      '',
      '### GitHub Actions',
      ...(facts.ci.length ? facts.ci.map((f) => `- ${codeSpan(`.github/workflows/${f}`)}`) : ['- 未发现 GitHub Actions 工作流']),
      '',
      '### 待确认',
      '- 以上基于目录与构建文件的启发式结果，请结合代码核对；未识别的技术栈补充到“项目补充”。',
    );
  }
  lines.push(AUTO_END);
  return lines.join('\n');
}

/** 事实指纹：只覆盖会影响自动段的结构信息，不含时间戳。 */
export function factsFingerprint({ facts, subprojects, rootTest }) {
  return sha256(JSON.stringify({
    techStack: facts.techStack,
    topDirs: facts.topDirs,
    entrypoints: facts.entrypoints,
    ci: facts.ci,
    subprojects: subprojects.map((s) => ({ path: s.path, testCommand: s.testCommand || null })),
    rootTest: rootTest || null,
  }));
}

export function readFactsFingerprint(text) {
  const m = FACTS_RE.exec(normalizeEol(text));
  return m ? m[1] : null;
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
  const facts = scanFacts(root, { subprojectPaths: hub.subprojects.map((s) => s.path) });
  const fingerprint = factsFingerprint({ facts, subprojects: hub.subprojects, rootTest: hub.rootTest });
  const block = buildAutoSection({ facts, subprojects: hub.subprojects, rootTest: hub.rootTest, now, full, fingerprint });
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
    fingerprint,
    subprojects: hub.subprojects,
  };
}
