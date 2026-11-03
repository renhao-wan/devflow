import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { referencedLoaders, templateIssues } from '../scripts/lib/template-compat.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

function makePlugin(base, files = {}) {
  const repo = join(base, 'plugin');
  mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
  writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'devflow',
    version: '1.0.0',
    license: 'MIT',
  }, null, 2));
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n');
  const all = {};
  for (const stage of STAGES) {
    all[`templates/stages/${stage}/SKILL.md`] = `---\nname: ${stage}\ndescription: ${stage}\n---\n\n${stage} v1\n`;
  }
  for (const [rel, content] of Object.entries({ ...all, ...files })) {
    const file = join(repo, ...rel.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return repo;
}

function makeProject(base, pluginRoot) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'compat-proj', scripts: { test: 'node --test' } }));
  const init = run('hub-init.mjs', ['--root', root, '--plugin-root', pluginRoot], root);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return root;
}

test('referencedLoaders 提取模板引用的 loader', () => {
  const text = '先跑 node scripts/devflow-triage.mjs --check，再跑 scripts/devflow-gen.mjs。';
  assert.deepEqual([...referencedLoaders(text)], ['devflow-triage.mjs', 'devflow-gen.mjs']);
});

test('templateIssues 标记插件未提供的 loader', () => {
  const issues = templateIssues('node scripts/devflow-unknown.mjs', {
    loaderFiles: new Set(['devflow-gen.mjs']),
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.match(issues[0].message, /devflow-unknown\.mjs/);
});

test('templateIssues 校验 minPluginVersion（无操作符按 >=）', () => {
  const text = (min) => `---\nname: review\ndescription: 评审\nminPluginVersion: ${min}\n---\n\n正文\n`;
  assert.equal(templateIssues(text('1.2.0'), { pluginVersion: '1.3.0' }).length, 0);
  const low = templateIssues(text('2.0.0'), { pluginVersion: '1.3.0' });
  assert.equal(low.length, 1);
  assert.equal(low[0].severity, 'warn');
  assert.match(low[0].message, /2\.0\.0/);
  assert.equal(templateIssues(text('>=1.0.0 <2.0.0'), { pluginVersion: '1.3.0' }).length, 0);
  assert.equal(templateIssues(text('额'), { pluginVersion: '1.3.0' })[0].severity, 'warn');
});

test('sync 跳过引用未知 loader 的个人库模板并保留本地内容', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-compat-'));
  try {
    const repo = makePlugin(base);
    const root = makeProject(base, repo);
    const personal = join(base, 'personal');
    mkdirSync(join(personal, 'templates', 'stages', 'review'), { recursive: true });
    writeFileSync(join(personal, 'templates', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 评审\n---\n\n调用 node scripts/devflow-unknown.mjs --check\n');

    const localFile = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');
    const before = readFileSync(localFile, 'utf8');

    const dry = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--personal-library', personal, '--dry-run'], root);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /不兼容，已跳过.*review\/SKILL\.md/);
    assert.match(dry.stdout, /devflow-unknown\.mjs/);

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--personal-library', personal], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.equal(readFileSync(localFile, 'utf8'), before);
    assert.match(sync.stdout, /不兼容 1/);

    // 跳过时不能丢掉同步基线，否则本地会被误判成手改，后续同步变成冲突。
    const sources = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.ok(sources.files['.claude/hub/stages/review/SKILL.md']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sync 跳过 minPluginVersion 高于当前插件的模板', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-compat-'));
  try {
    const repo = makePlugin(base);
    const root = makeProject(base, repo);
    const personal = join(base, 'personal');
    mkdirSync(join(personal, 'templates', 'stages', 'req'), { recursive: true });
    writeFileSync(join(personal, 'templates', 'stages', 'req', 'SKILL.md'),
      '---\nname: req\ndescription: 需求\nminPluginVersion: 9.0.0\n---\n\nreq personal\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', repo, '--personal-library', personal], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(sync.stdout, /不兼容 1/);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stages', 'req', 'SKILL.md'), 'utf8'), /req v1/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 报告项目模板引用的未知 loader', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-compat-'));
  try {
    const repo = makePlugin(base);
    const root = makeProject(base, repo);
    const target = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');
    writeFileSync(target, '---\nname: review\ndescription: 评审\n---\n\nnode scripts/devflow-unknown.mjs --check\n');

    const report = run('hub-doctor.mjs', ['--root', root, '--json'], root);
    assert.equal(report.status, 1);
    const rows = JSON.parse(report.stdout).rows;
    assert.ok(rows.some((r) => r.status === 'error' && /不兼容/.test(r.message) && /devflow-unknown/.test(r.message)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 对满足版本要求的 minPluginVersion 不报问题', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-compat-'));
  try {
    const repo = makePlugin(base);
    const root = makeProject(base, repo);
    const target = join(root, '.claude', 'hub', 'stages', 'req', 'SKILL.md');
    writeFileSync(target, '---\nname: req\ndescription: 需求\nminPluginVersion: 1.0.0\n---\n\nreq\n');
    const report = run('hub-doctor.mjs', ['--root', root, '--json'], root);
    const rows = JSON.parse(report.stdout).rows;
    assert.ok(rows.some((r) => /模板与当前插件兼容/.test(r.message)));
    assert.ok(!rows.some((r) => /minPluginVersion/.test(r.message)));
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
