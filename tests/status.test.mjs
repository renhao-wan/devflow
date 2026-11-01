import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-status.mjs');

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { ...r, json: r.status === 0 && r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

function makeTask(root, slug) {
  const dir = join(root, 'docs', 'devflow', slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(root, state) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify(state));
}

test('status 在无任务时提示开始需求阶段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-empty-'));
  try {
    const r = run(['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /未发现 docs\/devflow\//);
    assert.match(r.stdout, /\/devflow:req/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 按单个 slug 推断阶段并给出下一步', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-single-'));
  try {
    const dir = makeTask(root, 'add-login');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    writeFileSync(join(dir, 'plan.md'), '# plan\n');
    writeState(root, { testsPending: true });

    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const report = r.json;
    assert.equal(report.activeSlug, 'add-login');
    assert.equal(report.inferred, true);
    assert.equal(report.slugs[0].stage, 'test');
    assert.equal(report.slugs[0].gap, 'test.md');
    assert.match(report.slugs[0].next, /\/devflow:test add-login/);
    assert.ok(report.suggestions.some((s) => s.includes('尚未验证')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在审查产物齐全后标记完成', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-done-'));
  try {
    const dir = makeTask(root, 'fix-typo');
    for (const name of ['req.md', 'plan.md', 'test.md', 'review.md']) {
      writeFileSync(join(dir, name), '# x\n');
    }
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'done');
    assert.match(r.json.slugs[0].next, /upstream/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 完整流程审查早于测试证据时回到测试阶段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-review-no-test-'));
  try {
    const dir = makeTask(root, 'review-before-test');
    for (const name of ['req.md', 'plan.md', 'review.md']) {
      writeFileSync(join(dir, name), '# x\n');
    }
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'test');
    assert.equal(r.json.slugs[0].gap, 'test.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在审查后又有未验证改动时回到测试阶段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-retest-'));
  try {
    const dir = makeTask(root, 'post-review-change');
    for (const name of ['req.md', 'plan.md', 'test.md', 'review.md']) {
      writeFileSync(join(dir, name), '# x\n');
    }
    writeState(root, { testsPending: true });
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在多个任务时不擅自选择，也不套用全局测试状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-multi-'));
  try {
    const a = makeTask(root, 'a');
    writeFileSync(join(a, 'req.md'), '# a\n');
    writeFileSync(join(a, 'plan.md'), '# a\n');
    const b = makeTask(root, 'b');
    writeFileSync(join(b, 'req.md'), '# b\n');
    writeState(root, { testsPending: true });

    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.activeSlug, null);
    assert.equal(r.json.slugs.find((s) => s.slug === 'a').stage, 'implement');
    assert.ok(r.json.suggestions.some((s) => s.includes('请显式带上 slug')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 汇总工具路由与可用工具', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-route-'));
  try {
    const dir = makeTask(root, 'with-route');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'ecosystem.yaml'), 'version: 1\nrouting:\n  mode: auto\n');
    writeFileSync(join(root, '.claude', '.ecosystem-state.json'), JSON.stringify({
      schemaVersion: 1,
      detectedAt: new Date().toISOString(),
      tools: { superpowers: { available: true, signals: ['skill:brainstorming'] } },
    }));

    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.routing.configured, true);
    assert.equal(r.json.routing.mode, 'auto');
    assert.deepEqual(r.json.routing.availableTools, ['superpowers']);
    assert.equal(r.json.routing.stale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 不把已禁用的工具列为可用', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-disabled-'));
  try {
    const dir = makeTask(root, 'disabled-tool');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'ecosystem.yaml'), [
      'version: 1',
      'routing:',
      '  mode: auto',
      'tools:',
      '  superpowers:',
      '    enabled: false',
      '  bmad:',
      '    kind: workflow',
      '',
    ].join('\n'));
    writeFileSync(join(root, '.claude', '.ecosystem-state.json'), JSON.stringify({
      schemaVersion: 1,
      detectedAt: new Date().toISOString(),
      tools: {
        superpowers: { available: true, signals: ['skill:brainstorming'] },
        bmad: { available: true, signals: ['skill:bmad'] },
      },
    }));

    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.routing.availableTools, ['bmad']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在缺少生态索引时给出提示', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-no-route-'));
  try {
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.routing.configured, false);
    assert.ok(r.json.suggestions.some((s) => s.includes('ecosystem.yaml')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 支持 --slug 过滤，未知 slug 报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-filter-'));
  try {
    const dir = makeTask(root, 'only-one');
    writeFileSync(join(dir, 'req.md'), '# req\n');

    const ok = run(['--root', root, '--slug', 'only-one', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.json.inferred, false);
    assert.equal(ok.json.slugs.length, 1);

    const bad = run(['--root', root, '--slug', 'missing']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /未找到任务/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 把 brief.md 视为轻量功能的 req + plan', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-brief-'));
  try {
    const dir = makeTask(root, 'small-feature');
    writeFileSync(join(dir, 'brief.md'), '# brief\n');
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'implement');
    assert.equal(r.json.slugs[0].flow, 'light-feature');
    assert.equal(r.json.slugs[0].gap, null);
    assert.match(r.json.slugs[0].next, /\/devflow:implement small-feature/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 轻量功能必须有测试证据才进入 review', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-brief-review-'));
  try {
    const dir = makeTask(root, 'brief-review');
    writeFileSync(join(dir, 'brief.md'), '# brief\n');
    writeFileSync(join(dir, 'test.md'), '# test\n');
    const review = run(['--root', root, '--json']);
    assert.equal(review.json.slugs[0].stage, 'review');
    assert.equal(review.json.slugs[0].gap, 'review.md');

    rmSync(join(dir, 'test.md'));
    writeFileSync(join(dir, 'review.md'), '# review\n');
    const back = run(['--root', root, '--json']);
    assert.equal(back.json.slugs[0].stage, 'test');
    assert.equal(back.json.slugs[0].gap, 'test.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 轻量功能在改动未验证时回到 test', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-brief-pending-'));
  try {
    const dir = makeTask(root, 'brief-pending');
    writeFileSync(join(dir, 'brief.md'), '# brief\n');
    writeFileSync(join(dir, 'test.md'), '# test\n');
    writeFileSync(join(dir, 'review.md'), '# review\n');
    writeState(root, { testsPending: true });
    const r = run(['--root', root, '--json']);
    assert.equal(r.json.slugs[0].stage, 'test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 把单独 debug.md 视为轻量修复，下一步为 test', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-debug-'));
  try {
    const dir = makeTask(root, 'small-bug');
    writeFileSync(join(dir, 'debug.md'), '# debug\n');
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.slugs[0].stage, 'test');
    assert.equal(r.json.slugs[0].flow, 'light-bug');
    assert.equal(r.json.slugs[0].gap, 'test.md');
    assert.match(r.json.slugs[0].next, /\/devflow:test small-bug/);
    assert.equal(r.json.slugs[0].reviewRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 轻量修复测试通过后结束，风险项要求 review', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-debug-risk-'));
  try {
    const dir = makeTask(root, 'plain-bug');
    writeFileSync(join(dir, 'debug.md'), '# debug\n');
    writeFileSync(join(dir, 'test.md'), '# test\n');
    const done = run(['--root', root, '--json']);
    assert.equal(done.json.slugs[0].stage, 'done');

    writeFileSync(join(dir, 'debug.md'), '---\nreview: required\n---\n# debug\n');
    const review = run(['--root', root, '--json']);
    assert.equal(review.json.slugs[0].stage, 'review');
    assert.equal(review.json.slugs[0].reviewRequired, true);
    assert.equal(review.json.slugs[0].gap, 'review.md');

    rmSync(join(dir, 'test.md'));
    const back = run(['--root', root, '--json']);
    assert.equal(back.json.slugs[0].stage, 'test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 完整流程优先于 brief 与 debug', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-full-priority-'));
  try {
    const dir = makeTask(root, 'upgraded');
    writeFileSync(join(dir, 'brief.md'), '# brief\n');
    writeFileSync(join(dir, 'debug.md'), '# debug\n');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    writeFileSync(join(dir, 'plan.md'), '# plan\n');
    const r = run(['--root', root, '--json']);
    assert.equal(r.json.slugs[0].stage, 'implement');
    assert.equal(r.json.slugs[0].flow, 'full');

    writeFileSync(join(dir, 'debug.md'), '# debug\n');
    const stillFull = run(['--root', root, '--json']);
    assert.equal(stillFull.json.slugs[0].flow, 'full');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在多任务下仍分别推断轻量与完整流程', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-mixed-'));
  try {
    const full = makeTask(root, 'full-task');
    writeFileSync(join(full, 'req.md'), '# req\n');
    writeFileSync(join(full, 'plan.md'), '# plan\n');
    const bug = makeTask(root, 'bug-task');
    writeFileSync(join(bug, 'debug.md'), '# debug\n');
    writeState(root, { testsPending: true });

    const r = run(['--root', root, '--json']);
    assert.equal(r.json.activeSlug, null);
    assert.equal(r.json.slugs.find((s) => s.slug === 'full-task').stage, 'implement');
    assert.equal(r.json.slugs.find((s) => s.slug === 'bug-task').stage, 'test');
    assert.ok(r.json.suggestions.some((s) => s.includes('请显式带上 slug')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 无任务时提示轻量与排障入口', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-empty-light-'));
  try {
    const r = run(['--root', root]);
    assert.match(r.stdout, /--light/);
    assert.match(r.stdout, /\/devflow:debug/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 文本输出标注轻量模式与需补审查', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-text-light-'));
  try {
    const feature = makeTask(root, 'tiny-feature');
    writeFileSync(join(feature, 'brief.md'), '# brief\n');
    const featureText = run(['--root', root]);
    assert.equal(featureText.status, 0, featureText.stderr);
    assert.match(featureText.stdout, /模式：轻量功能/);
    assert.doesNotMatch(featureText.stdout, /需补审查/);

    const bug = makeTask(root, 'risky-bug');
    writeFileSync(join(bug, 'debug.md'), '---\nreview: required\n---\n# debug\n');
    writeFileSync(join(bug, 'test.md'), '# test\n');
    const reviewText = run(['--root', root, '--slug', 'risky-bug']);
    assert.equal(reviewText.status, 0, reviewText.stderr);
    assert.match(reviewText.stdout, /模式：轻量修复，需补审查/);

    writeFileSync(join(bug, 'review.md'), '# review\n');
    const doneText = run(['--root', root, '--slug', 'risky-bug']);
    assert.match(doneText.stdout, /阶段：done/);
    assert.doesNotMatch(doneText.stdout, /需补审查/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 只认 debug.md 前 10 行的 review: required', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-review-head-'));
  try {
    const dir = makeTask(root, 'head-markers');
    writeFileSync(join(dir, 'test.md'), '# test\n');

    const cases = [
      { name: '注释不生效', body: '---\n# review: required\n---\n', expected: false },
      { name: '第 11 行不生效', body: `---\n${Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join('\n')}\n---\nreview: required\n`, expected: false },
      { name: 'CRLF 生效', body: '---\r\nreview: required\r\n---\r\n', expected: true },
      { name: '双引号生效', body: '---\nreview: "required"\n---\n', expected: true },
      { name: '单引号生效', body: "---\nreview: 'required'\n---\n", expected: true },
      { name: '行尾注释不生效', body: '---\nreview: required # risk\n---\n', expected: false },
    ];

    for (const item of cases) {
      writeFileSync(join(dir, 'debug.md'), item.body);
      const r = run(['--root', root, '--json']);
      assert.equal(r.json.slugs[0].reviewRequired, item.expected, item.name);
      assert.equal(r.json.slugs[0].stage, item.expected ? 'review' : 'done', item.name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 的 --slug 可过滤轻量任务', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-filter-light-'));
  try {
    const full = makeTask(root, 'full-task');
    writeFileSync(join(full, 'req.md'), '# req\n');
    const bug = makeTask(root, 'bug-task');
    writeFileSync(join(bug, 'debug.md'), '# debug\n');

    const r = run(['--root', root, '--slug', 'bug-task', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.inferred, false);
    assert.equal(r.json.slugs.length, 1);
    assert.equal(r.json.slugs[0].flow, 'light-bug');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 在 brief 升级为完整流程时按 req/plan 推断', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-brief-upgrade-'));
  try {
    const dir = makeTask(root, 'half-upgraded');
    writeFileSync(join(dir, 'brief.md'), '# brief\n');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    const r = run(['--root', root, '--json']);
    assert.equal(r.json.slugs[0].flow, 'full');
    assert.equal(r.json.slugs[0].stage, 'plan');
    assert.equal(r.json.slugs[0].gap, 'plan.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 混用 brief 与 debug 时按轻量功能处理，不误标 reviewRequired', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-brief-debug-'));
  try {
    const dir = makeTask(root, 'mixed-light');
    writeFileSync(join(dir, 'brief.md'), '# brief\n');
    writeFileSync(join(dir, 'debug.md'), '---\nreview: required\n---\n# debug\n');
    writeFileSync(join(dir, 'test.md'), '# test\n');
    const r = run(['--root', root, '--json']);
    assert.equal(r.json.slugs[0].flow, 'light-feature');
    assert.equal(r.json.slugs[0].reviewRequired, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status 完整流程不因 debug.md 的风险标记改变推断', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-status-full-debug-risk-'));
  try {
    const dir = makeTask(root, 'full-with-debug');
    writeFileSync(join(dir, 'req.md'), '# req\n');
    writeFileSync(join(dir, 'plan.md'), '# plan\n');
    writeFileSync(join(dir, 'test.md'), '# test\n');
    writeFileSync(join(dir, 'debug.md'), '---\nreview: required\n---\n# debug\n');
    const r = run(['--root', root, '--json']);
    assert.equal(r.json.slugs[0].flow, 'full');
    assert.equal(r.json.slugs[0].reviewRequired, false);
    assert.equal(r.json.slugs[0].stage, 'review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
