#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  isMain, projectRoot, argValue, hasFlag, updateJson,
} from './lib/common.mjs';
import { collectChanges } from './lib/review.mjs';

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/i;
const DOC_FILE = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|txt)$/i;
const GENERATED_FILE = /(^|\/)(dist|build|coverage|node_modules)(\/|$)|\.(min|map)(\.[^.]+)?$/i;
const CONFIG_FILE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|jsconfig[^/]*\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|[^/]+\.config\.[^/]+)$/i;

function isSourceFile(path) {
  return !TEST_FILE.test(path) && !DOC_FILE.test(path) && !GENERATED_FILE.test(path) && !CONFIG_FILE.test(path);
}

function stem(path) {
  return basename(path, extname(path));
}

/** `a.test.js` / `a.spec.ts` 与 `a.js` 视为同一被测对象。 */
function subjectStem(path) {
  return basename(path).replace(/\.(test|spec)\.[^.]+$/, '').replace(/\.[^.]+$/, '');
}

/** 常见测试命名与目录约定；只做存在性检查，不解析测试内容。 */
function testCandidates(file) {
  const ext = extname(file);
  const base = stem(file);
  const dir = dirname(file);
  const out = [
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join(dir, '__tests__', `${base}${ext}`),
    join(dir, '__tests__', `${base}.test${ext}`),
    join(dir, '__tests__', `${base}.spec${ext}`),
  ];
  for (const prefix of ['test', 'tests']) {
    const relocated = file.replace(/^(src|lib|app)\//, `${prefix}/`);
    if (relocated === file) continue;
    const e = extname(relocated);
    const b = basename(relocated, e);
    const d = dirname(relocated);
    out.push(
      join(d, `${b}.test${e}`),
      join(d, `${b}.spec${e}`),
      join(d, '__tests__', `${b}${e}`),
      join(d, '__tests__', `${b}.test${e}`),
    );
  }
  return out;
}

export function findTestGaps(root, { base = null } = {}) {
  const changes = collectChanges(root, { base });
  const paths = changes.files.map((file) => String(file.path || '').replace(/\\/g, '/')).filter(Boolean);
  const changedTests = new Set(paths.filter((path) => TEST_FILE.test(path)).map(subjectStem));
  const sources = paths.filter(isSourceFile);

  const gaps = [];
  const covered = [];
  for (const file of sources) {
    if (changedTests.has(subjectStem(file))) {
      covered.push({ file, evidence: '同次改动包含同名测试文件' });
      continue;
    }
    const hit = testCandidates(file).find((candidate) => existsSync(join(root, candidate)));
    if (hit) {
      covered.push({ file, evidence: hit.replace(/\\/g, '/') });
      continue;
    }
    gaps.push({ file });
  }
  return {
    gaps,
    covered,
    stats: {
      changedFiles: paths.length,
      sourceFiles: sources.length,
      changedTestFiles: paths.filter((path) => TEST_FILE.test(path)).length,
    },
    warnings: changes.warnings,
    statsAvailable: changes.statsAvailable,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const base = argValue(argv, '--base', null);

  if (hasFlag(argv, '--gaps')) {
    const json = hasFlag(argv, '--json');
    const report = findTestGaps(root, { base });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    if (!report.statsAvailable) {
      console.log('[WARN] 无法统计 git 改动，测试缺口提示不完整；请人工核对。');
    }
    if (!report.stats.changedFiles) {
      console.log('[OK]   没有可统计的改动。');
    } else if (!report.gaps.length) {
      console.log(`[OK]   源码改动均有对应测试痕迹（${report.stats.sourceFiles} 个源码文件）。`);
    } else {
      console.log(`[GAPS] ${report.gaps.length} 个源码文件未见对应测试改动或测试文件（只提示，不阻断）：`);
      for (const gap of report.gaps) console.log(`  - ${gap.file}`);
      console.log('  若已由现有测试覆盖，请在 test.md 写明对应测试与依据。');
    }
    for (const warning of report.warnings) console.log(`  注意：${warning}`);
    return report;
  }

  const command = argValue(argv, '--command', null);
  const file = join(root, '.claude', '.devflow-state.json');
  const state = updateJson(file, (current) => {
    const next = current && typeof current === 'object' ? current : {};
    next.lastTestPassedAt = new Date().toISOString();
    next.testsPending = false;
    if (command) next.lastTestCommand = command;
    return next;
  });
  console.log(`[OK]   已记录测试通过：${state.lastTestPassedAt}${command ? `（${command}）` : ''}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
