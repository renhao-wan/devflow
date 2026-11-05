import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveLibraries, collectTemplateFiles, assertLibraryRoot, defaultPersonalRoot, describeLibraries,
} from '../scripts/lib/libraries.mjs';

function makeDir(base, name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTemplate(root, rel, content) {
  const file = join(root, 'templates', ...rel.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

test('没有 templates 块的旧项目只使用上游库', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const upstream = makeDir(base, 'upstream');
    const libs = resolveLibraries(makeDir(base, 'project'), {}, {
      pluginRoot: upstream,
      personalLibrary: makeDir(base, 'personal'),
      env: {},
    });
    assert.deepEqual(libs.map((l) => l.kind), ['upstream']);
    assert.equal(libs[0].root, upstream);
    assert.equal(libs[0].templateRoot, join(upstream, 'templates'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('新项目默认启用个人库并保留上游兜底', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const upstream = makeDir(base, 'upstream');
    const personal = makeDir(base, 'personal');
    const libs = resolveLibraries(makeDir(base, 'project'), {
      templates: { order: ['personal', 'upstream'], personal: { enabled: true } },
    }, { pluginRoot: upstream, personalLibrary: personal, env: {} });
    assert.deepEqual(libs.map((l) => l.kind), ['personal', 'upstream']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库按配置排在最前，order 缺上游时自动补兜底', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const team = makeDir(base, 'team');
    const libs = resolveLibraries(makeDir(base, 'project'), {
      templates: { order: ['team', 'personal'], team: { enabled: true, path: team } },
    }, {
      pluginRoot: makeDir(base, 'upstream'),
      personalLibrary: makeDir(base, 'personal'),
      env: {},
    });
    assert.deepEqual(libs.map((l) => l.kind), ['team', 'personal', 'upstream']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库参与合并但路径缺失或不存在时给出明确错误', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const root = makeDir(base, 'project');
    const opts = { pluginRoot: makeDir(base, 'upstream'), personalLibrary: makeDir(base, 'personal'), env: {} };
    const order = ['team', 'personal', 'upstream'];
    assert.throws(
      () => resolveLibraries(root, { templates: { order, team: { enabled: true, repo: 'https://example.com/t.git' } } }, opts),
      /git clone https:\/\/example\.com\/t\.git/,
    );
    assert.throws(
      () => resolveLibraries(root, { templates: { order, team: { enabled: true, path: 'missing' } } }, opts),
      /团队模板库路径不存在/,
    );
    // 未写进 order 的团队库不参与合并，路径问题不应阻断个人/上游同步。
    assert.deepEqual(
      resolveLibraries(root, { templates: { team: { enabled: true, repo: 'https://example.com/t.git' } } }, opts)
        .map((lib) => lib.kind),
      ['personal', 'upstream'],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('个人库不存在视为空库，不报错', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const libs = resolveLibraries(makeDir(base, 'project'), {
      templates: { order: ['personal', 'upstream'] },
    }, {
      pluginRoot: makeDir(base, 'upstream'),
      personalLibrary: join(base, 'not-created'),
      env: {},
    });
    assert.deepEqual(libs.map((l) => l.kind), ['personal', 'upstream']);
    assert.deepEqual(collectTemplateFiles(libs), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('collectTemplateFiles 先到先得，并映射 shared 到 _shared', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const team = makeDir(base, 'team');
    const personal = makeDir(base, 'personal');
    const upstream = makeDir(base, 'upstream');
    writeTemplate(team, 'stages/review/SKILL.md', 'team review\n');
    writeTemplate(personal, 'stages/review/SKILL.md', 'personal review\n');
    writeTemplate(personal, 'stages/plan/SKILL.md', 'personal plan\n');
    writeTemplate(upstream, 'stages/review/SKILL.md', 'upstream review\n');
    writeTemplate(upstream, 'stages/req/SKILL.md', 'upstream req\n');
    writeTemplate(upstream, 'shared/common.md', 'shared\n');
    writeTemplate(upstream, 'stacks/java-spring/_shared.md', 'java shared\n');
    writeTemplate(personal, 'stacks/java-spring/plan.md', 'java plan\n');
    writeTemplate(upstream, 'stages/review/SKILL.md.bak-1', 'backup\n');

    const libs = resolveLibraries(makeDir(base, 'project'), {
      templates: { order: ['team', 'personal', 'upstream'], team: { enabled: true, path: team } },
    }, { pluginRoot: upstream, personalLibrary: personal, env: {} });
    const files = collectTemplateFiles(libs);
    const byRel = Object.fromEntries(files.map((f) => [f.hubRel, f]));

    assert.equal(byRel['stages/review/SKILL.md'].source, 'team');
    assert.equal(byRel['stages/review/SKILL.md'].destRel, '.claude/hub/stages/review/SKILL.md');
    assert.equal(byRel['stages/plan/SKILL.md'].source, 'personal');
    assert.equal(byRel['stages/req/SKILL.md'].source, 'upstream');
    assert.equal(byRel['_shared/common.md'].source, 'upstream');
    assert.equal(byRel['_shared/common.md'].destRel, '.claude/hub/_shared/common.md');
    assert.equal(byRel['stacks/java-spring/_shared.md'].source, 'upstream');
    assert.equal(byRel['stacks/java-spring/_shared.md'].destRel, '.claude/hub/stacks/java-spring/_shared.md');
    assert.equal(byRel['stacks/java-spring/plan.md'].source, 'personal');
    assert.equal(byRel['stages/review/SKILL.md.bak-1'], undefined);
    assert.ok(!files.some((f) => f.hubRel.includes('_feedback-log')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('高优先库的草稿不遮蔽低优先库的正式模板', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-draft-'));
  try {
    const personal = makeDir(base, 'personal');
    const upstream = makeDir(base, 'upstream');
    writeTemplate(personal, 'stages/review/SKILL.md', '<!-- devflow:draft -->\n# 草稿\n\n- TODO: 补充。\n');
    writeTemplate(upstream, 'stages/review/SKILL.md', 'upstream review\n');
    writeTemplate(personal, 'stages/plan/SKILL.md', '<!-- devflow:draft -->\n# 草稿\n\n- TODO: 补充。\n');

    const libs = resolveLibraries(makeDir(base, 'project'), {
      templates: { order: ['personal', 'upstream'] },
    }, { pluginRoot: upstream, personalLibrary: personal, env: {} });
    const byRel = Object.fromEntries(collectTemplateFiles(libs).map((f) => [f.hubRel, f]));

    // personal 的草稿让位给 upstream 的正式模板。
    assert.equal(byRel['stages/review/SKILL.md'].source, 'upstream');
    // 没有任何正式模板时，草稿仍会返回，由调用方跳过并统计。
    assert.equal(byRel['stages/plan/SKILL.md'].source, 'personal');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('模板库不能与项目互相嵌套，也不能落在插件缓存', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const project = makeDir(base, 'project');
    const inside = makeDir(project, '.claude/devflow');
    const parent = makeDir(base, 'parent');
    const sibling = makeDir(base, 'sibling');

    assert.throws(() => assertLibraryRoot(project, project), /不能是当前项目根/);
    assert.throws(() => assertLibraryRoot(project, inside), /不能位于当前项目内/);
    assert.throws(() => assertLibraryRoot(join(parent, 'sub'), parent), /当前项目不能位于模板库内/);
    assert.throws(() => assertLibraryRoot(project, join(base, 'plugins', 'cache', 'x'), 'personal'), /安装缓存/);
    assert.equal(assertLibraryRoot(project, sibling), true);
    assert.equal(assertLibraryRoot(project, join(base, 'plugins', 'cache', 'x'), 'upstream'), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('模板库嵌套与缓存校验会解析 junction', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证 junction');
    return;
  }
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-junction-'));
  const links = [];
  try {
    const project = makeDir(base, 'project');
    const inside = makeDir(project, '.claude/devflow');
    const cache = makeDir(base, 'plugins/cache/x');

    const linkInside = join(base, 'link-inside');
    const linkCache = join(base, 'link-cache');
    for (const [link, target] of [[linkInside, inside], [linkCache, cache]]) {
      const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
      if (made.status !== 0) {
        t.skip('mklink /J 不可用');
        return;
      }
      links.push(link);
    }

    // junction 指向项目内目录：原始路径看起来在项目外，必须按真实路径拒绝。
    assert.throws(() => assertLibraryRoot(project, linkInside), /不能位于当前项目内/);
    assert.throws(() => assertLibraryRoot(project, linkCache, 'personal'), /安装缓存/);
  } finally {
    for (const link of links) spawnSync('cmd', ['/c', 'rmdir', link], { encoding: 'utf8' });
    rmSync(base, { recursive: true, force: true });
  }
});

test('默认个人库位于用户 .claude/devflow', () => {
  assert.match(defaultPersonalRoot().replace(/\\/g, '/'), /\.claude\/devflow$/);
});

test('describeLibraries 不抛错，报告团队库路径问题与三个库路径', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const root = makeDir(base, 'project');
    const upstream = makeDir(base, 'upstream');
    const personal = makeDir(base, 'personal');
    const desc = describeLibraries(root, {
      templates: {
        order: ['team', 'personal', 'upstream'],
        team: { enabled: true, path: '../missing-team', repo: 'https://example.com/t.git' },
      },
    }, { pluginRoot: upstream, personalLibrary: personal, env: {} });

    assert.deepEqual(desc.order, ['team', 'personal', 'upstream']);
    assert.equal(desc.team.enabled, true);
    assert.equal(desc.team.root, null);
    assert.match(desc.team.error, /不存在/);
    assert.match(desc.team.repo, /example\.com/);
    assert.equal(desc.personal.root, personal);
    assert.equal(desc.personal.exists, true);
    assert.equal(desc.upstream.root, upstream);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('personal.enabled=false 时个人库不参与来源合并，但仍可显式回灌', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-libs-'));
  try {
    const upstream = makeDir(base, 'upstream');
    const personal = makeDir(base, 'personal');
    const config = { templates: { order: ['personal', 'upstream'], personal: { enabled: false } } };
    const libs = resolveLibraries(makeDir(base, 'project'), config, {
      pluginRoot: upstream, personalLibrary: personal, env: {},
    });
    assert.deepEqual(libs.map((l) => l.kind), ['upstream']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
