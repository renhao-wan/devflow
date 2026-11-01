import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPrBody } from '../scripts/hub-ship.mjs';

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
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'devflow', version: '1.0.0' }, null, 2));
  writeFileSync(join(repo, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'devflow-marketplace',
    metadata: { version: '1.0.0' },
  }, null, 2));
  writeFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'), '旧内容\n');

  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'devflow-test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['branch', '-M', 'main']);

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

    const plugin = JSON.parse(git(bare, ['show', `${branchName}:.claude-plugin/plugin.json`]));
    assert.equal(plugin.version, '1.0.1');
    const pkg = JSON.parse(git(bare, ['show', `${branchName}:package.json`]));
    assert.equal(pkg.version, '1.0.1');
    const market = JSON.parse(git(bare, ['show', `${branchName}:.claude-plugin/marketplace.json`]));
    assert.equal(market.metadata.version, '1.0.1');

    const template = git(bare, ['show', `${branchName}:templates/stages/review/SKILL.md`]);
    assert.match(template, /先看正确性/);

    const log = git(bare, ['show', `${branchName}:templates/stages/_feedback-log.md`]);
    assert.match(log, /回灌文件/);

    // 回灌只在临时 worktree 中发生：主工作区版本与分支不变，也不留下未提交改动。
    assert.equal(JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.0.0');
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(git(repo, ['status', '--porcelain']), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship 从 --base 创建分支，不携带当前分支的无关提交', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-base-'));
  try {
    const root = makeProject();
    const { repo } = makePluginRepo(base);

    git(repo, ['checkout', '-b', 'feature']);
    writeFileSync(join(repo, 'unrelated.txt'), '无关改动\n');
    git(repo, ['add', 'unrelated.txt']);
    git(repo, ['commit', '-m', 'chore: feature 分支无关提交']);
    const unrelated = git(repo, ['rev-parse', 'HEAD']);

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo, '--base', 'main'], repo);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const branches = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n');
    const branch = branches.find((b) => b.startsWith('devflow/upstream-review'));
    assert.ok(branch, `未找到回灌分支：${branches.join('、')}`);
    // 临时 worktree 方案不切换主工作区
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
    const subjects = git(repo, ['log', '--format=%s', `main..${branch}`]).split('\n');
    assert.equal(subjects.length, 1, subjects.join('\n'));
    assert.match(subjects[0], /回灌 review 阶段规则/);
    assert.notEqual(spawnSync('git', ['merge-base', '--is-ancestor', unrelated, branch], { cwd: repo }).status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ship 在基分支缺失时先失败，不改插件工作区', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-nobase-'));
  try {
    const root = makeProject();
    const { repo } = makePluginRepo(base);
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 审查\n---\n\n通用内容：先看正确性。\n');
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

    const r = run(['--root', root, '--stage', 'review', '--plugin-root', repo, '--base', 'no-such-base'], repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /找不到 --base/);
    const plugin = JSON.parse(readFileSync(join(repo, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '1.0.0');
    assert.equal(readFileSync(join(repo, 'templates', 'stages', 'review', 'SKILL.md'), 'utf8'), '旧内容\n');
    assert.equal(git(repo, ['status', '--porcelain']), '');
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
    assert.match(r.stdout, /没有可回灌/);
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

test('PR 正文复用仓库模板', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-body-'));
  try {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.github'), { recursive: true });
    writeFileSync(join(repo, '.github', 'pull_request_template.md'), [
      '## 变更内容',
      '',
      '<!-- 说明 -->',
      '',
      '## 类型',
      '',
      '- [ ] feat',
      '',
      '## 关联',
      '',
      '## 验证',
      '',
      '- [ ] node --test',
      '',
      '## 影响面',
      '',
      '- 影响范围：',
    ].join('\n'));

    const body = buildPrBody(repo, {
      stage: 'review',
      projectName: 'demo',
      files: ['templates/stages/review/SKILL.md'],
      oldVersion: '1.0.0',
      newVersion: '1.1.0',
      kind: 'minor',
    });
    assert.match(body, /回灌 review 阶段规则，来源项目：demo/);
    assert.match(body, /## 类型[\s\S]*- \[x\] feat/);
    assert.match(body, /阶段：review/);
    assert.match(body, /templates\/stages\/review\/SKILL\.md/);
    assert.match(body, /1\.0\.0 → 1\.1\.0（minor）/);
    assert.doesNotMatch(body, /<!-- 说明 -->/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('PR 正文在缺少模板时退回内置结构', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-ship-notpl-'));
  try {
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    const body = buildPrBody(repo, {
      stage: 'test', projectName: 'demo', files: ['templates/stages/test/SKILL.md'],
      oldVersion: '1.0.0', newVersion: '1.0.1', kind: 'patch',
    });
    assert.match(body, /## 变更内容/);
    assert.match(body, /## 影响面/);
    assert.match(body, /templates\/stages\/test\/SKILL\.md/);
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
