import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-ship.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '' },
  });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ship-proj-'));
  const stageDir = join(root, '.claude', 'hub', 'stages', 'review');
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'SKILL.md'), [
    '---',
    'name: review',
    'description: 审查',
    '---',
    '',
    '通用内容：先看正确性。',
    '',
  ].join('\n'));
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'requiresPlugin: "^1.0.0"',
    'stages:',
    '  - review',
    'subprojects: {}',
    'defaults:',
    '  testCommand: "npm test"',
    'upstream:',
    '  blocklist: []',
    '',
  ].join('\n'));
  return root;
}

function makePluginRepo(base) {
  const repo = join(base, 'plugin');
  mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
  mkdirSync(join(repo, 'templates', 'stages', 'review'), { recursive: true });
  writeFileSync(join(repo, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'devflow',
    version: '1.0.0',
  }, null, 2));
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n');
  writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'), '旧内容\n');

  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'devflow-test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);

  const bare = join(base, 'remote.git');
  git(base, ['init', '--bare', bare]);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/test-owner/devflow.git']);
  git(repo, ['remote', 'set-url', '--push', 'origin', bare]);
  return { repo, bare };
}

test('ship 提交回灌并推送分支，输出 PR 链接', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-'));
  try {
    const root = makeProject();
    const { repo, bare } = makePluginRepo(base);
    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo], repo);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    assert.match(r.stdout, /compare\/main\.\.\.devflow\/upstream-review/);

    const branches = git(bare, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    const branchName = branches.split('\n').find((b) => b.startsWith('devflow/upstream-review'));
    assert.ok(branchName, `未找到回灌分支：${branches}`);

    const subject = git(bare, ['log', '--format=%s', '-1', branchName]);
    assert.match(subject, /回灌 review 阶段规则/);

    const plugin = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '1.0.1');

    const template = readFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'), 'utf8');
    assert.match(template, /先看正确性/);

    const log = readFileSync(join(repo, 'templates', 'stages', '_feedback-log.md'), 'utf8');
    assert.match(log, /回灌文件/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship 在白名单文件已脏时拒绝执行', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-dirty-'));
  try {
    const root = makeProject();
    const { repo } = makePluginRepo(base);
    writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n未提交改动\n');

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo], repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /请先提交或 stash/);
    assert.match(r.stderr, /CHANGELOG\.md/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship 缺少 --stage 时报错', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-nostage-'));
  try {
    const root = makeProject();
    const { repo } = makePluginRepo(base);
    const r = run(['--root', root, '--plugin-root', repo], repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--stage/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship --dry-run 不改文件、不建分支', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-dry-'));
  try {
    const root = makeProject();
    const { repo, bare } = makePluginRepo(base);
    const before = readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8');

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo, '--dry-run'], repo);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /dry-run/);
    assert.equal(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8'), before);
    assert.doesNotMatch(spawnSync('git', ['branch', '--list'], { cwd: bare, encoding: 'utf8' }).stdout, /upstream/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship 在无可回灌内容时不建分支', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-local-'));
  try {
    const root = makeProject();
    const { repo, bare } = makePluginRepo(base);
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '内网 192.168.1.1\n');

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo], repo);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /没有可回灌内容/);
    assert.doesNotMatch(spawnSync('git', ['branch', '--list'], { cwd: bare, encoding: 'utf8' }).stdout, /upstream/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship --dry-run 在白名单文件已脏时仍可预览', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-drydirty-'));
  try {
    const root = makeProject();
    const { repo } = makePluginRepo(base);
    writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n未提交改动\n');

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo, '--dry-run'], repo);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /警告/);
    assert.match(r.stdout, /CHANGELOG\.md/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship 拒绝非 git 仓库作为插件目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-nogit-'));
  try {
    const root = makeProject();
    const fake = join(base, 'fake-plugin');
    mkdirSync(join(fake, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fake, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', fake], base);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /不是 git 仓库/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
