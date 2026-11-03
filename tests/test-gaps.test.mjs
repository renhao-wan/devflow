import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTestGaps } from '../scripts/mark-test.mjs';

const SCRIPT = join(resolve(import.meta.dirname, '..'), 'scripts', 'mark-test.mjs');

function git(root, ...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gaps-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function commit(root, message = 'base') {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
}

function write(root, rel, text) {
  const file = join(root, ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
}

test('源码改动没有测试改动时给出缺口提示', () => {
  const root = initRepo();
  try {
    write(root, 'src/a.js', 'export const a = 1;\n');
    commit(root);
    write(root, 'src/a.js', 'export const a = 2;\n');
    const report = findTestGaps(root);
    assert.deepEqual(report.gaps.map((g) => g.file), ['src/a.js']);
    assert.equal(report.stats.sourceFiles, 1);
    assert.equal(report.stats.changedTestFiles, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同次改动包含同名测试时视为已覆盖', () => {
  const root = initRepo();
  try {
    write(root, 'src/a.js', 'export const a = 1;\n');
    commit(root);
    write(root, 'src/a.js', 'export const a = 2;\n');
    write(root, 'src/a.test.js', 'import "./a.js";\n');
    const report = findTestGaps(root);
    assert.equal(report.gaps.length, 0);
    assert.ok(report.covered.some((c) => c.file === 'src/a.js' && /同名测试/.test(c.evidence)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('仓库内已有约定测试文件时视为已覆盖', () => {
  const root = initRepo();
  try {
    write(root, 'src/b.js', 'export const b = 1;\n');
    write(root, 'tests/b.test.js', 'test("b", () => {});\n');
    commit(root);
    write(root, 'src/b.js', 'export const b = 2;\n');
    const report = findTestGaps(root);
    assert.equal(report.gaps.length, 0);
    assert.ok(report.covered.some((c) => c.file === 'src/b.js' && c.evidence.includes('tests/b.test.js')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('测试、文档、生成物与配置文件不进入缺口', () => {
  const root = initRepo();
  try {
    write(root, 'src/c.js', 'export const c = 1;\n');
    commit(root);
    write(root, 'src/c.test.js', 'test("c", () => {});\n');
    write(root, 'docs/c.md', '# c\n');
    write(root, 'src/c.min.js', 'c;\n');
    write(root, 'package.json', '{"name":"c"}\n');
    const report = findTestGaps(root);
    assert.equal(report.gaps.length, 0);
    assert.equal(report.stats.sourceFiles, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --gaps 输出提示且退出码为 0，--json 输出结构化结果', () => {
  const root = initRepo();
  try {
    write(root, 'src/d.js', 'export const d = 1;\n');
    commit(root);
    write(root, 'src/d.js', 'export const d = 2;\n');

    const text = run(['--root', root, '--gaps'], root);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\[GAPS\] 1 个源码文件/);
    assert.match(text.stdout, /src\/d\.js/);

    const json = run(['--root', root, '--gaps', '--json'], root);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).gaps[0].file, 'src/d.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非 git 目录标记统计不完整，但不阻断', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gaps-nogit-'));
  try {
    const report = findTestGaps(root);
    assert.equal(report.statsAvailable, false);
    assert.equal(report.gaps.length, 0);
    assert.ok(report.warnings.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
