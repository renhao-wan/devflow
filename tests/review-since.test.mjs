import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReviewReport } from '../scripts/lib/review-gate.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'review-triage.mjs');

function git(root, ...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function initRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function write(root, rel, content = 'x\n') {
  mkdirSync(join(root, ...rel.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD').stdout.trim();
}

function run(args, root) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  return { ...r, json };
}

const REVIEW = (incremental) => `# 审查记录

## 结论

- [x] 可以交付

## 阻断项

| 文件:行 | 问题 | 触发条件 | 建议 |
| --- | --- | --- | --- |
${incremental ? '\n## 增量复审\n\n- 旧阻断项处置：沿用，src/a.js:10 仍需修复\n' : ''}
## 审查触发与画像

- 触发：mandatory
- 风险等级：low
- 选中方向：correctness 正确性
`;

const TRIAGE = {
  trigger: 'mandatory',
  level: 'low',
  selected: ['correctness'],
  assignments: [],
  deferred: [],
  excluded: [],
  scope: { mode: 'incremental', since: 'deadbeef' },
};

test('--since 只统计锚点之后的改动并写入增量 scope', () => {
  const root = initRepo('devflow-since-');
  try {
    write(root, 'docs/devflow/demo/req.md', '# 需求\n');
    commit(root, 'base');
    write(root, 'src/a.js');
    const anchor = commit(root, 'a');
    write(root, 'src/b.js');
    const head = commit(root, 'b');

    const r = run(['--slug', 'demo', '--since', anchor, '--json', '--write'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.stats.files, 1);
    assert.deepEqual(r.json.scope, {
      mode: 'incremental',
      since: anchor,
      base: null,
      head,
      diffHash: r.json.scope.diffHash,
    });
    assert.match(r.json.scope.diffHash, /^[0-9a-f]{12}$/);

    const saved = JSON.parse(readFileSync(join(root, 'docs/devflow/demo/review-triage.json'), 'utf8'));
    assert.equal(saved.scope.mode, 'incremental');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('全量 triage 写入 mode=full', () => {
  const root = initRepo('devflow-since-full-');
  try {
    write(root, 'docs/devflow/demo/req.md', '# 需求\n');
    commit(root, 'base');
    write(root, 'src/a.js');
    commit(root, 'a');

    const r = run(['--slug', 'demo', '--json'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.scope.mode, 'full');
    assert.equal(r.json.scope.since, null);
    assert.match(r.json.scope.diffHash, /^[0-9a-f]{12}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--since 与 --base / --check 互斥', () => {
  const root = initRepo('devflow-since-excl-');
  try {
    write(root, 'docs/devflow/demo/req.md', '# 需求\n');
    const base = commit(root, 'base');
    write(root, 'src/a.js');
    commit(root, 'a');

    const both = run(['--slug', 'demo', '--since', base, '--base', base], root);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /不能同时使用/);

    const check = run(['--slug', 'demo', '--since', base, '--check'], root);
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /--check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--since 指向非 HEAD 祖先时明确报错', () => {
  const root = initRepo('devflow-since-orphan-');
  try {
    write(root, 'docs/devflow/demo/req.md', '# 需求\n');
    commit(root, 'base');
    const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    git(root, 'checkout', '-q', '--orphan', 'other');
    write(root, 'orphan.txt');
    const orphan = commit(root, 'orphan');
    git(root, 'checkout', '-q', branch);

    const r = run(['--slug', 'demo', '--since', orphan], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不是 HEAD 的祖先/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('增量模式的 review.md 必须交代旧阻断项处置', () => {
  const root = initRepo('devflow-since-gate-');
  try {
    const dir = join(root, 'docs', 'devflow', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.md'), REVIEW(false));
    const missing = checkReviewReport(root, 'demo', { triage: TRIAGE });
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.includes('增量复审')));

    writeFileSync(join(dir, 'review.md'), REVIEW(true));
    const ok = checkReviewReport(root, 'demo', { triage: TRIAGE });
    assert.equal(ok.ok, true, ok.errors.join('；'));

    writeFileSync(join(dir, 'review.md'), REVIEW(true).replace('沿用，src/a.js:10 仍需修复', '沿用 / 已修复 / 失效'));
    const placeholder = checkReviewReport(root, 'demo', { triage: TRIAGE });
    assert.equal(placeholder.ok, false);
    assert.ok(placeholder.errors.some((e) => e.includes('旧阻断项处置')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('全量模式的 review.md 不要求增量小节', () => {
  const root = initRepo('devflow-since-full-gate-');
  try {
    const dir = join(root, 'docs', 'devflow', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.md'), REVIEW(false));
    const result = checkReviewReport(root, 'demo', { triage: { ...TRIAGE, scope: { mode: 'full' } } });
    assert.equal(result.ok, true, result.errors.join('；'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
