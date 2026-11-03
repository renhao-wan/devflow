import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DIRECTIONS, buildReviewPlan, detectFlow, profileChanges, readReviewMarker,
} from '../scripts/lib/review.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'review-triage.mjs');

function run(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
  let json = null;
  if (r.status === 0) {
    try { json = JSON.parse(r.stdout); } catch { json = null; }
  }
  return { ...r, json };
}

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

function makeTask(root, slug, files = {}) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function baseline(root) {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
}

function directions(rows) {
  return rows.map((r) => r.direction).sort();
}

test('高危路径与凭据内容触发特别审查，方向与上限正确', () => {
  const profile = profileChanges({
    files: [{ path: 'src/auth/session.js', additions: 6, deletions: 1 }],
    diffText: '+++ b/src/auth/session.js\n+const token = process.env.API_TOKEN;\n',
  });
  assert.equal(profile.level, 'special');
  assert.equal(profile.maxAgents, 4);
  assert.ok(profile.selected.some((r) => r.direction === 'security'));
  assert.ok(profile.assignments.some((a) => a.directions.includes('security')));
});

test('用户指定方向优先，其余方向让位并记录原因', () => {
  const profile = profileChanges({
    files: [{ path: 'src/auth/session.js', additions: 20, deletions: 0 }],
    diffText: '+++ b/src/auth/session.js\n+const token = process.env.API_TOKEN;\n',
    focus: ['data'],
  });
  assert.equal(profile.maxAgents, 1);
  assert.deepEqual(directions(profile.selected), ['data']);
  const excluded = profile.excluded.find((r) => r.direction === 'security');
  assert.ok(excluded);
  assert.match(excluded.reason, /用户指定/);
});

test('用户指定方向数超过上限时保留方向并记为待补查', () => {
  const profile = profileChanges({
    files: [{ path: 'src/app.js', additions: 1, deletions: 0 }],
    focus: ['security', 'data', 'concurrency', 'deps', 'acceptance'],
  });
  assert.equal(profile.maxAgents, 4);
  assert.equal(profile.selected.length, 5);
  assert.equal(profile.assignments.flatMap((a) => a.directions).length, 4);
  assert.ok(profile.deferred.some((r) => /超出代理上限/.test(r.reason)));
  assert.equal(profile.excluded.some((r) => /超出代理上限/.test(r.reason)), false);
});

test('--no-subagents 与 --agents 0 把代理上限降为 0，但保留方向画像', () => {
  const files = [{ path: 'src/auth/session.js', additions: 5, deletions: 0 }];
  const none = profileChanges({ files, noSubagents: true });
  assert.equal(none.maxAgents, 0);
  assert.equal(none.capSource, 'none');
  assert.ok(none.ranked.some((r) => r.direction === 'security'));
  assert.ok(none.selected.some((r) => r.direction === 'security'));
  assert.equal(none.assignments.length, 0);
  assert.ok(none.deferred.every((r) => /不派子代理/.test(r.reason)));

  const zero = profileChanges({ files, agents: 0 });
  assert.equal(zero.maxAgents, 0);
  assert.equal(zero.capSource, 'user');
  assert.ok(zero.selected.some((r) => r.direction === 'security'));
  assert.ok(zero.deferred.every((r) => /0 个代理/.test(r.reason)));
});

test('--focus-only 不派代理，并把命中方向记为排除', () => {
  const profile = profileChanges({
    files: [{ path: 'src/auth/session.js', additions: 5, deletions: 0 }],
    focusOnly: true,
  });
  assert.equal(profile.selected.length, 0);
  assert.equal(profile.assignments.length, 0);
  assert.ok(profile.excluded.some((r) => r.direction === 'security'));
});

test('低风险小改动不产生方向，等级为 low', () => {
  const profile = profileChanges({
    files: [{ path: 'src/util/format.js', additions: 1, deletions: 0 }],
    diffText: '+++ b/src/util/format.js\n+export const pad = (s) => s;\n',
  });
  assert.equal(profile.level, 'low');
  assert.equal(profile.selected.length, 0);
  assert.equal(profile.excluded.length, 0);
});

test('完整任务与轻量功能始终必审', () => {
  for (const flow of ['full', 'light-feature', 'unknown']) {
    const plan = buildReviewPlan({ flow });
    assert.equal(plan.trigger, 'mandatory', flow);
  }
});

test('轻量修复无标记且风险低时跳过，并留痕不派代理', () => {
  const plan = buildReviewPlan({
    flow: 'light-bug',
    files: [{ path: 'src/util/format.js', additions: 1, deletions: 0 }],
    diffText: '+++ b/src/util/format.js\n+export const pad = (s) => s;\n',
  });
  assert.equal(plan.trigger, 'skipped');
  assert.equal(plan.maxAgents, 0);
  assert.equal(plan.selected.length, 0);
  assert.equal(plan.assignments.length, 0);
});

test('轻量修复的 review: required 标记触发审查', () => {
  const plan = buildReviewPlan({ flow: 'light-bug', reviewRequired: true });
  assert.equal(plan.trigger, 'required');
  assert.equal(plan.reviewRequired, true);
});

test('轻量修复命中高风险信号时自动审查', () => {
  const plan = buildReviewPlan({
    flow: 'light-bug',
    files: [{ path: 'src/auth/session.js', additions: 5, deletions: 0 }],
    diffText: '+++ b/src/auth/session.js\n+const token = process.env.API_TOKEN;\n',
  });
  assert.equal(plan.trigger, 'auto');
  assert.ok(plan.selected.some((r) => r.direction === 'security'));
});

test('用户显式指定方向或代理数时按用户要求审查', () => {
  const byFocus = buildReviewPlan({ flow: 'light-bug', focus: ['security'] });
  assert.equal(byFocus.trigger, 'user');

  const byAgents = buildReviewPlan({
    flow: 'light-bug',
    agents: 2,
    files: [{ path: 'src/util/format.js', additions: 1, deletions: 0 }],
  });
  assert.equal(byAgents.trigger, 'user');
});

test('readReviewMarker 只读 debug.md 前 10 行', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-marker-'));
  try {
    const dir = makeTask(root, 'bug', {
      'debug.md': ['# debug', 'review: required', '## 正确行为依据', '- 行为'].join('\n'),
    });
    assert.equal(readReviewMarker(root, 'bug'), 'required');
    assert.equal(detectFlow(root, 'bug'), 'light-bug');

    writeFileSync(join(dir, 'debug.md'), ['# debug', ...Array(12).fill('x'), 'review: required'].join('\n'));
    assert.equal(readReviewMarker(root, 'bug'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 输出 JSON 计划，--write 落盘相同内容', () => {
  const root = initRepo('devflow-triage-cli-');
  try {
    const dir = makeTask(root, 'fix-login', {
      'debug.md': '# debug\nreview: required\n\n## 正确行为依据\n- 登录成功\n',
    });
    mkdirSync(join(root, 'src', 'auth'), { recursive: true });
    writeFileSync(join(root, 'src', 'auth', 'login.js'), 'export const login = 1;\n');
    baseline(root);
    writeFileSync(join(root, 'src', 'auth', 'login.js'), 'export const login = 2;\nconst token = "x";\n');

    const r = run(['--root', root, '--json', '--write']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slug, 'fix-login');
    assert.equal(r.json.flow, 'light-bug');
    assert.equal(r.json.trigger, 'required');
    assert.ok(r.json.selected.some((x) => x.direction === 'security'));

    const file = join(dir, 'review-triage.json');
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), r.json);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 在非 git 目录仍给出计划并说明无法统计改动', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-triage-nogit-'));
  try {
    makeTask(root, 'req-a', { 'req.md': '# req\n' });
    const r = run(['--root', root, '--json', '--slug', 'req-a']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.trigger, 'mandatory');
    assert.ok(r.json.warnings.some((w) => w.includes('不是 git 仓库')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 对多个任务、非法方向与缺失任务给出明确错误', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-triage-errors-'));
  try {
    makeTask(root, 'a', { 'req.md': '# a\n' });
    makeTask(root, 'b', { 'debug.md': '# b\n' });

    const multi = run(['--root', root]);
    assert.equal(multi.status, 1);
    assert.match(multi.stderr, /多个任务/);

    const badFocus = run(['--root', root, '--slug', 'a', '--focus', 'nope']);
    assert.equal(badFocus.status, 1);
    assert.match(badFocus.stderr, /未知审查方向/);

    const missing = run(['--root', root, '--slug', 'ghost']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /未找到任务/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DIRECTIONS 与默认排除保持一致', () => {
  assert.equal(DIRECTIONS.length, 8);
  const profile = profileChanges({
    files: [
      { path: 'src/app.js', additions: 2, deletions: 0 },
      { path: 'tests/app.test.js', additions: 2, deletions: 0 },
    ],
    diffText: '+++ b/src/app.js\n+TODO: 补测试\n',
  });
  assert.equal(profile.selected.some((r) => r.direction === 'maintainability'), false);
  assert.equal(profile.selected.some((r) => r.direction === 'tests'), false);
  assert.ok(profile.excluded.some((r) => r.direction === 'maintainability'));
});

test('自动触发但未命中方向时补基线方向，不留空计划', () => {
  const acceptance = buildReviewPlan({
    flow: 'light-bug',
    files: [{ path: 'src/api/contract.ts', additions: 2, deletions: 0 }],
  });
  assert.equal(acceptance.trigger, 'auto');
  assert.ok(acceptance.selected.some((r) => r.direction === 'acceptance'));

  const scale = buildReviewPlan({
    flow: 'light-bug',
    files: [{ path: 'src/app.js', additions: 250, deletions: 0 }],
  });
  assert.equal(scale.trigger, 'auto');
  assert.deepEqual(scale.selected.map((r) => r.direction), ['correctness']);

  const agents = buildReviewPlan({ flow: 'light-bug', agents: 2 });
  assert.equal(agents.trigger, 'user');
  assert.deepEqual(agents.selected.map((r) => r.direction), ['correctness']);
  assert.ok(agents.assignments.some((a) => a.directions.includes('correctness')));
});

test('无法统计改动时不自动跳过，并给出基线方向', () => {
  const plan = buildReviewPlan({ flow: 'light-bug', statsAvailable: false });
  assert.equal(plan.trigger, 'auto');
  assert.ok(plan.selected.some((r) => r.direction === 'correctness'));
});

test('特别风险下禁用子代理，方向保留且排除理由不误写低风险', () => {
  const profile = profileChanges({
    files: [
      { path: 'src/auth/session.js', additions: 10, deletions: 1 },
      { path: 'src/db/init.sql', additions: 20, deletions: 1 },
    ],
    noSubagents: true,
  });
  assert.equal(profile.level, 'special');
  assert.ok(profile.selected.length >= 2);
  assert.equal(profile.assignments.length, 0);
  assert.ok(profile.excluded.every((r) => !/风险等级低/.test(r.reason)));
  assert.ok(profile.deferred.every((r) => /不派子代理/.test(r.reason)));
});

test('统计规模只计源码，文档与测试不计入 codeFiles', () => {
  const profile = profileChanges({
    files: [
      { path: 'README.md', additions: 300, deletions: 0 },
      { path: 'tests/big.test.js', additions: 300, deletions: 0 },
      { path: 'src/app.js', additions: 1, deletions: 0 },
    ],
  });
  assert.equal(profile.stats.changedLines, 601);
  assert.equal(profile.stats.codeChangedLines, 1);
  assert.equal(profile.stats.codeFiles, 1);
  // 测试路径本身带来 1 分，但 300 行测试不会因规模升级为 high。
  assert.equal(profile.level, 'medium');

  const docsOnly = profileChanges({
    files: [
      { path: 'README.md', additions: 300, deletions: 0 },
      { path: 'src/app.js', additions: 1, deletions: 0 },
    ],
  });
  assert.equal(docsOnly.level, 'low');
});

test('测试与规则定义中的正则文本不放大内容风险', () => {
  const profile = profileChanges({
    diffText: [
      '+++ b/src/app.js',
      '+const ok = 1;',
      '+++ b/tests/review-triage.test.mjs',
      '+const sql = "ALTER TABLE users";',
      '+++ b/scripts/lib/review.mjs',
      '+const re = /mutex|transaction/;',
    ].join('\n'),
  });
  assert.equal(profile.ranked.length, 0);
});

test('CLI 拒绝 --focus-only 与 --focus 同时使用', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-triage-conflict-'));
  try {
    makeTask(root, 'a', { 'req.md': '# a\n' });
    const r = run(['--root', root, '--slug', 'a', '--focus-only', '--focus', 'security']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不能与 --focus 同时使用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 支持 --root= 形式', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-triage-eq-'));
  try {
    makeTask(root, 'a', { 'req.md': '# a\n' });
    const r = run([`--root=${root}`, '--slug', 'a', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slug, 'a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未跟踪文件的内容参与风险扫描', () => {
  const root = initRepo('devflow-triage-untracked-');
  try {
    makeTask(root, 'fix', { 'debug.md': '# debug\n' });
    writeFileSync(join(root, 'schema.sql'), 'ALTER TABLE users ADD COLUMN age int;\n');
    const r = run(['--root', root, '--json', '--slug', 'fix']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.trigger, 'auto');
    assert.ok(r.json.selected.some((x) => x.direction === 'data'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 在非 git 目录的轻量修复不会据空 diff 跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-triage-nogit-bug-'));
  try {
    makeTask(root, 'fix', { 'debug.md': '# debug\n' });
    const r = run(['--root', root, '--json', '--slug', 'fix']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.trigger, 'auto');
    assert.ok(r.json.selected.length > 0);
    assert.ok(r.json.warnings.some((w) => w.includes('不会据空 diff 自动跳过审查')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
