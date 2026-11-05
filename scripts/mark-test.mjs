#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  isMain, projectRoot, argValue, hasFlag, hasOption, updateJson, isPathInside, isRealPathInside,
  unknownArgs,
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

/** 对每个源码改动文件列出可能受影响的已存在测试；只提示，不执行测试。 */
export function findChangedTests(root, { base = null } = {}) {
  const changes = collectChanges(root, { base });
  const paths = changes.files.map((file) => String(file.path || '').replace(/\\/g, '/')).filter(Boolean);
  // 已删除的文件不在工作区：不能作为覆盖证据或待运行测试，但仍计入改动统计。
  const existing = paths.filter((path) => existsSync(join(root, path)));
  const changedTestFiles = existing.filter((path) => TEST_FILE.test(path));
  const changedStems = new Set(changedTestFiles.map(subjectStem));
  const tests = new Set(changedTestFiles);
  const sources = existing.filter(isSourceFile);

  const unmapped = [];
  for (const file of sources) {
    const found = new Set();
    if (changedStems.has(subjectStem(file))) {
      for (const test of changedTestFiles) {
        if (subjectStem(test) === subjectStem(file)) found.add(test);
      }
    }
    for (const candidate of testCandidates(file)) {
      if (existsSync(join(root, candidate))) found.add(candidate.replace(/\\/g, '/'));
    }
    for (const test of found) tests.add(test);
    if (!found.size) unmapped.push(file);
  }
  return {
    tests: [...tests].sort(),
    unmapped,
    stats: {
      changedFiles: paths.length,
      sourceFiles: sources.length,
      changedTestFiles: changedTestFiles.length,
    },
    warnings: changes.warnings,
    statsAvailable: changes.statsAvailable,
  };
}

export function findTestGaps(root, { base = null } = {}) {
  const changes = collectChanges(root, { base });
  const paths = changes.files.map((file) => String(file.path || '').replace(/\\/g, '/')).filter(Boolean);
  // 已删除的文件不在工作区：不能当作覆盖证据，但删除本身仍属于改动统计。
  const existing = paths.filter((path) => existsSync(join(root, path)));
  const changedTests = new Set(existing.filter((path) => TEST_FILE.test(path)).map(subjectStem));
  const sources = existing.filter(isSourceFile);

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
      changedTestFiles: existing.filter((path) => TEST_FILE.test(path)).length,
    },
    warnings: changes.warnings,
    statsAvailable: changes.statsAvailable,
  };
}

function parseCount(raw, name) {
  if (raw === null) return null;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} 需要非负整数，收到：${raw}`);
  return Number(raw);
}

const KNOWN_FLAGS = new Set([
  '--root', '--base', '--gaps', '--changed', '--json', '--command',
  '--exit-code', '--duration-ms', '--help', '-h',
]);

/** 拒绝未知长参数，避免拼错时静默按默认行为执行（例如 test --help 被当成一次通过）。 */
function assertKnownArgs(argv) {
  const unknown = unknownArgs(argv, KNOWN_FLAGS);
  if (unknown.length) throw new Error(`未知参数：${unknown[0]}`);
}


export async function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log([
      '用法：devflow test [选项]',
      '',
      '  --gaps                 列出缺少测试痕迹的源码改动',
      '  --changed              列出可能受影响的测试文件',
      '  --exit-code <n>        记录测试退出码（非负整数；0 表示通过）',
      '  --duration-ms <n>      记录耗时（毫秒）',
      '  --command <cmd>        记录测试命令',
      '  --json                 输出 JSON',
      '  --root <dir>           项目根目录',
      '  --base <ref>           比较基线',
    ].join('\n'));
    return null;
  }
  assertKnownArgs(argv);
  const root = argValue(argv, '--root', projectRoot());
  const base = argValue(argv, '--base', null);
  const gaps = hasFlag(argv, '--gaps');
  const changed = hasFlag(argv, '--changed');
  const json = hasFlag(argv, '--json');
  if (gaps && changed) throw new Error('--gaps 与 --changed 不能同时使用');

  if (gaps) {
    const report = findTestGaps(root, { base });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    if (!report.statsAvailable) {
      console.log('[WARN] 无法统计 git 改动，测试缺口提示不完整；请人工核对。');
    } else if (!report.stats.changedFiles) {
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

  if (changed) {
    const report = findChangedTests(root, { base });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    if (!report.statsAvailable) {
      console.log('[WARN] 无法统计 git 改动，受影响测试提示不完整；请人工核对。');
    } else if (!report.stats.changedFiles) {
      console.log('[OK]   没有可统计的改动。');
    }
    if (report.tests.length) {
      console.log(`[CHANGED] ${report.tests.length} 个测试文件可能受影响（只提示，不阻断）：`);
      for (const test of report.tests) console.log(`  - ${test}`);
    }
    if (report.unmapped.length) {
      console.log(`[UNMAPPED] ${report.unmapped.length} 个源码文件未映射到已存在测试，建议跑全量或补充测试：`);
      for (const file of report.unmapped) console.log(`  - ${file}`);
    }
    if (!report.statsAvailable) {
      console.log('  无法确定受影响范围时，优先运行全量测试。');
    } else if (!report.tests.length && !report.unmapped.length && report.stats.changedFiles) {
      console.log('  没有可提示的受影响测试。');
    }
    for (const warning of report.warnings) console.log(`  注意：${warning}`);
    return report;
  }

  const command = argValue(argv, '--command', null);
  const exitCodeRaw = argValue(argv, '--exit-code', null);
  // 标志存在但没拿到合法值时必须报错，不能回退成 0 把失败记录为通过。
  if (hasOption(argv, '--exit-code') && exitCodeRaw === null) {
    throw new Error('--exit-code 需要非负整数，例如 --exit-code 1 或 --exit-code=1');
  }
  const exitCode = exitCodeRaw === null ? 0 : parseCount(exitCodeRaw, '--exit-code');
  const durationRaw = argValue(argv, '--duration-ms', null);
  if (hasOption(argv, '--duration-ms') && durationRaw === null) {
    throw new Error('--duration-ms 需要非负整数');
  }
  const durationMs = durationRaw === null ? null : parseCount(durationRaw, '--duration-ms');
  const passed = exitCode === 0;
  const at = new Date().toISOString();
  const file = join(root, '.claude', '.devflow-state.json');
  // 状态文件与 .claude 目录都可能被 junction/符号链接替换，写入前必须确认仍在项目内。
  if (!isPathInside(root, file) || !isRealPathInside(root, file)) {
    throw new Error(`拒绝写入项目外的状态文件：${file}`);
  }
  const state = updateJson(file, (current) => {
    const next = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    next.lastTestAt = at;
    next.lastTestExitCode = exitCode;
    next.lastTestStatus = passed ? 'passed' : 'failed';
    if (durationMs !== null) next.lastTestDurationMs = durationMs;
    if (command) next.lastTestCommand = command;
    if (passed) {
      next.lastTestPassedAt = at;
      next.testsPending = false;
    } else {
      // 失败运行不能清除“待验证”，否则 hooks 会误以为改动已验证。
      next.testsPending = true;
    }
    return next;
  });

  if (json) {
    console.log(JSON.stringify({
      recorded: true,
      status: state.lastTestStatus,
      exitCode: state.lastTestExitCode,
      durationMs: state.lastTestDurationMs ?? null,
      command: state.lastTestCommand ?? null,
      at: state.lastTestAt,
    }, null, 2));
    return state;
  }
  if (passed) {
    console.log(`[OK]   已记录测试通过：${state.lastTestPassedAt}${command ? `（${command}）` : ''}`);
  } else {
    console.log(`[FAIL] 已记录测试失败（exit ${exitCode}）；testsPending 保持为 true${command ? `（${command}）` : ''}`);
  }
  return state;
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
