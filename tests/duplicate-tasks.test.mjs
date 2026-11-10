import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { duplicateGroups, normalizeTitle } from '../scripts/lib/artifact-chain.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-status.mjs');

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-duplicate-'));
  mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'version: 1\n');
  return root;
}

function writeTask(root, slug, files) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

function json(root, args = []) {
  const result = run(root, ['--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('标题规范化忽略空白、标点、大小写与轻量后缀', () => {
  assert.equal(normalizeTitle('  报表 导出！ '), normalizeTitle('报表导出'));
  assert.equal(normalizeTitle('Report Export'), normalizeTitle('report-export'));
  assert.equal(normalizeTitle('报表导出（轻量功能）'), normalizeTitle('报表导出'));
  assert.equal(normalizeTitle(''), '');
});

test('相同标题的任务归为一组，不同标题与空标题不误报', () => {
  const groups = duplicateGroups([
    { slug: 'a', title: '报表导出' },
    { slug: 'b', title: '报表 导出！' },
    { slug: 'c', title: '登录改造' },
    { slug: 'd', title: '' },
  ]);
  assert.deepEqual(groups, [{ title: '报表导出', slugs: ['a', 'b'] }]);
});

test('status 报告标题相同的重复任务并给出合并提示', () => {
  const root = makeRoot();
  try {
    writeTask(root, 'report', { 'req.md': '# 报表导出\n\n## 目标\n\n导出报表。\n' });
    writeTask(root, 'export', { 'req.md': '# 报表 导出\n\n## 目标\n\n导出报表。\n' });
    writeTask(root, 'login', { 'req.md': '# 登录改造\n\n## 目标\n\n改造登录。\n' });

    const report = json(root);
    assert.deepEqual(report.duplicates, [{ title: '报表导出', slugs: ['export', 'report'] }]);
    assert.ok(report.suggestions.some((line) => /疑似重复任务.*export.*report/.test(line)));

    const text = run(root).stdout;
    assert.match(text, /疑似重复任务：export、report（标题：报表导出）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('按 --slug 查询单个任务时仍提示与其他任务重复', () => {
  const root = makeRoot();
  try {
    writeTask(root, 'report', { 'req.md': '# 报表导出\n' });
    writeTask(root, 'export', { 'req.md': '# 报表导出\n' });
    const report = json(root, ['--slug', 'report']);
    assert.equal(report.slugs.length, 1);
    assert.deepEqual(report.duplicates, [{ title: '报表导出', slugs: ['export', 'report'] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('轻量 brief 的标题与完整 req 相同时视为重复', () => {
  const root = makeRoot();
  try {
    writeTask(root, 'report', { 'req.md': '# 报表导出\n' });
    writeTask(root, 'report-light', { 'brief.md': '# 报表导出（轻量功能）\n' });
    const report = json(root);
    assert.deepEqual(report.duplicates, [{ title: '报表导出', slugs: ['report', 'report-light'] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('只有归档目录的任务不参与重复检测', () => {
  const root = makeRoot();
  try {
    writeTask(root, 'report', { 'req.md': '# 报表导出\n' });
    mkdirSync(join(root, 'docs', 'devflow', 'old', '.archive', '20260101-000000-000'), { recursive: true });
    writeFileSync(join(root, 'docs', 'devflow', 'old', '.archive', '20260101-000000-000', 'req.md'), '# 报表导出\n');
    const report = json(root);
    assert.deepEqual(report.duplicates, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
