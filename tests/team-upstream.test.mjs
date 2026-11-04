import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contentHash } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function makeProject(base, { withTemplates = false } = {}) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, '.claude', 'hub', 'stages', 'review'), { recursive: true });
  mkdirSync(join(root, '.claude', 'hub', '_shared'), { recursive: true });
  writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), [
    '---',
    'name: review',
    'description: 审查',
    '---',
    '',
    '通用内容：先看正确性。',
    '',
  ].join('\n'));
  writeFileSync(join(root, '.claude', 'hub', '_shared', 'common.md'), '共享规则：先写测试。\n');
  writeFileSync(join(root, '.devflow.json'), JSON.stringify({ pluginRoot: PLUGIN_ROOT, pluginVersion: '1.0.0' }));
  const hub = [
    'version: 1',
    'requiresPlugin: "*"',
    'stages:',
    '  - review',
    'subprojects: {}',
    'defaults:',
    '  testCommand: "npm test"',
  ];
  if (withTemplates) {
    hub.push('templates:', '  order: [personal, upstream]', '  personal:', '    enabled: true');
  }
  hub.push('upstream:', '  blocklist: []', '');
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), hub.join('\n'));
  return root;
}

function readLog(libRoot) {
  const file = join(libRoot, '.devflow', 'upstream-log.jsonl');
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('个人库回灌：写入 templates、记录日志、不碰版本文件', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-personal-up-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const result = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const target = join(personal, 'templates', 'stages', 'review', 'SKILL.md');
    assert.match(readFileSync(target, 'utf8'), /通用内容/);
    assert.equal(existsSync(join(personal, '.claude-plugin', 'plugin.json')), false);

    const entry = readLog(personal).at(-1);
    assert.equal(entry.mode, 'personal');
    assert.deepEqual(entry.files, ['templates/stages/review/SKILL.md']);
    assert.equal(entry.oldVersion, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('个人库回灌支持共享规则，并可被另一个项目同步复用', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-personal-shared-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const up = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--shared', '--apply',
    ], root);
    assert.equal(up.status, 0, up.stderr + up.stdout);
    assert.ok(existsSync(join(personal, 'templates', 'shared', 'common.md')));

    // 另一个启用个人库的项目同步后拿到该规则。
    const other = makeProject(join(base, 'other'), { withTemplates: true });
    const sync = run('hub-sync.mjs', [
      '--root', other, '--personal-library', personal,
    ], other);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(other, '.claude', 'hub', '_shared', 'common.md'), 'utf8'), /先写测试/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('个人库不支持 --pr', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-personal-args-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const pr = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--pr',
    ], root);
    assert.notEqual(pr.status, 0);
    assert.match(pr.stderr, /个人库不支持 --pr/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('个人库回灌后可按记录回滚到旧内容', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-personal-revert-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const target = join(personal, 'templates', 'stages', 'review', 'SKILL.md');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, '旧的个人模板\n');

    const up = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.equal(up.status, 0, up.stderr + up.stdout);
    assert.match(readFileSync(target, 'utf8'), /通用内容/);

    const id = readLog(personal).at(-1).id;
    const revert = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--revert', id,
    ], root);
    assert.equal(revert.status, 0, revert.stderr + revert.stdout);
    assert.equal(readFileSync(target, 'utf8'), '旧的个人模板\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('不再支持 local / remote 别名', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-no-alias-'));
  try {
    const root = makeProject(base);
    for (const alias of ['local', 'remote']) {
      const result = run('hub-upstream.mjs', ['--root', root, '--to', alias, '--stage', 'review'], root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--to 只支持 personal\|team\|upstream/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('个人库中断续做：文件已写入但日志缺失时，重跑补写日志并清理 journal', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-personal-resume-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const target = join(personal, 'templates', 'stages', 'review', 'SKILL.md');
    const first = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.equal(first.status, 0, first.stderr + first.stdout);

    // 模拟“文件已复制、日志未写、进程中断”：目标内容与模板一致，重跑时 pending 为 0。
    const id = readLog(personal).at(-1).id;
    rmSync(join(personal, '.devflow', 'upstream-log.jsonl'), { force: true });
    rmSync(join(personal, 'docs', 'upstream-log.md'), { force: true });
    const journalFile = join(personal, '.devflow', 'upstream-journal.json');
    writeFileSync(journalFile, JSON.stringify({
      id,
      units: ['stage:review'],
      files: ['templates/stages/review/SKILL.md'],
      created: ['templates/stages/review/SKILL.md'],
      createdAt: new Date().toISOString(),
    }));

    const again = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /继续完成/);
    assert.equal(existsSync(journalFile), false);
    assert.equal(readLog(personal).at(-1).id, id);
    assert.ok(existsSync(join(personal, 'docs', 'upstream-log.md')));

    // 续做补齐日志后仍可回滚：本次新建的文件应被删除。
    const revert = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--revert', id,
    ], root);
    assert.equal(revert.status, 0, revert.stderr + revert.stdout);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('个人库中断续做：中断后修改目标文件时拒绝，--force 才覆盖', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-personal-resume-dirty-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const target = join(personal, 'templates', 'stages', 'review', 'SKILL.md');
    const first = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.equal(first.status, 0, first.stderr + first.stdout);

    const id = readLog(personal).at(-1).id;
    const rel = 'templates/stages/review/SKILL.md';
    const journalFile = join(personal, '.devflow', 'upstream-journal.json');
    writeFileSync(journalFile, JSON.stringify({
      id,
      units: ['stage:review'],
      files: [rel],
      created: [],
      hashes: { [rel]: contentHash(readFileSync(target, 'utf8')) },
      before: { [rel]: contentHash(readFileSync(target, 'utf8')) },
      createdAt: new Date().toISOString(),
    }));

    // 模拟中断后用户又改了同一个目标文件。
    writeFileSync(target, '中断后手改\n');
    const denied = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /中断后被修改/);
    assert.equal(readFileSync(target, 'utf8'), '中断后手改\n');
    assert.ok(existsSync(journalFile));

    const forced = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply', '--force',
    ], root);
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);
    assert.match(readFileSync(target, 'utf8'), /通用内容/);
    assert.equal(existsSync(journalFile), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库中断续做：放行上次写入的脏文件，但拒绝中断后又被修改的文件', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-resume-'));
  try {
    const root = makeProject(base);
    const team = join(base, 'team');
    mkdirSync(team, { recursive: true });
    assert.equal(git(team, ['init']).status, 0);

    const args = ['--root', root, '--to', 'team', '--team-library', team, '--stage', 'review', '--shared'];
    const first = run('hub-upstream.mjs', [...args, '--apply'], root);
    assert.equal(first.status, 0, first.stderr + first.stdout);

    const id = readLog(team).at(-1).id;
    const review = 'templates/stages/review/SKILL.md';
    const shared = 'templates/shared/common.md';
    const journalFile = join(team, '.devflow', 'upstream-journal.json');
    const writeJournal = () => writeFileSync(journalFile, JSON.stringify({
      id,
      units: ['stage:review', 'shared:shared'],
      files: [shared, review],
      created: [],
      hashes: {
        [review]: contentHash(readFileSync(join(team, review), 'utf8')),
        [shared]: contentHash(readFileSync(join(team, shared), 'utf8')),
      },
      before: { [review]: null, [shared]: null },
      createdAt: new Date().toISOString(),
    }));

    // 上次写入的团队文件在 git 里是脏的，但内容与 journal 一致：续做应放行。
    writeJournal();
    const resumed = run('hub-upstream.mjs', [...args, '--apply'], root);
    assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
    assert.match(resumed.stdout, /继续完成/);
    assert.equal(existsSync(journalFile), false);

    // 再模拟一次中断，这次用户改了尚未完成的目标文件：必须拒绝。
    writeJournal();
    writeFileSync(join(team, review), '中断后手改\n');
    const denied = run('hub-upstream.mjs', [...args, '--apply'], root);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /中断后被修改/);
    assert.equal(readFileSync(join(team, review), 'utf8'), '中断后手改\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库默认只写工作区，不提交也不升版本', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-up-'));
  try {
    const root = makeProject(base);
    const team = join(base, 'team');
    mkdirSync(team, { recursive: true });
    assert.equal(git(team, ['init']).status, 0);

    const result = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team, '--stage', 'review', '--apply',
    ], root);
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const target = join(team, 'templates', 'stages', 'review', 'SKILL.md');
    assert.match(readFileSync(target, 'utf8'), /通用内容/);
    assert.match(git(team, ['status', '--porcelain']).stdout, /templates\//);
    assert.notEqual(git(team, ['rev-parse', '--verify', 'HEAD']).status, 0);
    assert.equal(existsSync(join(team, 'package.json')), false);

    const entry = readLog(team).at(-1);
    assert.equal(entry.mode, 'team');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库支持回灌技术栈规范', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-stack-'));
  try {
    const root = makeProject(base);
    const team = join(base, 'team');
    mkdirSync(team, { recursive: true });
    assert.equal(git(team, ['init']).status, 0);

    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, '_shared.md'), '# Java 通用\n');

    const result = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team, '--stack', 'java-spring', '--apply',
    ], root);
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const target = join(team, 'templates', 'stacks', 'java-spring', '_shared.md');
    assert.match(readFileSync(target, 'utf8'), /Java 通用/);
    assert.match(readFileSync(join(team, '.devflow', 'upstream-log.jsonl'), 'utf8'), /java-spring 技术栈/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库目标文件有未提交改动时拒绝，--force 备份后覆盖', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-dirty-'));
  try {
    const root = makeProject(base);
    const team = join(base, 'team');
    mkdirSync(join(team, 'templates', 'stages', 'review'), { recursive: true });
    assert.equal(git(team, ['init']).status, 0);
    const target = join(team, 'templates', 'stages', 'review', 'SKILL.md');
    writeFileSync(target, '团队手写模板\n');

    const denied = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team, '--stage', 'review', '--apply',
    ], root);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /未提交改动/);

    const forced = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team, '--stage', 'review', '--apply', '--force',
    ], root);
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);
    assert.match(readFileSync(target, 'utf8'), /通用内容/);

    const id = readLog(team).at(-1).id;
    const backup = join(team, '.devflow', 'backups', id, 'templates', 'stages', 'review', 'SKILL.md');
    assert.equal(readFileSync(backup, 'utf8'), '团队手写模板\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库必须是 git 仓库顶层', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-git-'));
  try {
    const root = makeProject(base);
    const team = join(base, 'team');
    mkdirSync(team, { recursive: true });
    const notGit = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team, '--stage', 'review', '--apply',
    ], root);
    assert.notEqual(notGit.status, 0);
    assert.match(notGit.stderr, /必须是 git 仓库/);

    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    assert.equal(git(repo, ['init']).status, 0);
    const notTop = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', join(repo, 'sub'), '--stage', 'review', '--apply',
    ], root);
    assert.notEqual(notTop.status, 0);
    assert.match(notTop.stderr, /必须是 git 仓库顶层/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('团队库 --pr：在 bare remote 上创建分支与提交，不升版本', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-pr-'));
  try {
    const root = makeProject(base);
    const remote = join(base, 'remote.git');
    mkdirSync(remote);
    assert.equal(git(remote, ['init', '--bare', '--initial-branch=main']).status, 0);

    const team = join(base, 'team');
    mkdirSync(join(team, 'templates', 'stages', 'review'), { recursive: true });
    assert.equal(git(team, ['init', '--initial-branch=main']).status, 0);
    git(team, ['config', 'user.email', 'test@example.com']);
    git(team, ['config', 'user.name', 'devflow-test']);
    writeFileSync(join(team, 'README.md'), '# team templates\n');
    writeFileSync(join(team, 'templates', 'stages', 'review', 'SKILL.md'), '团队旧模板\n');
    git(team, ['add', '.']);
    assert.equal(git(team, ['commit', '-m', 'init']).status, 0);
    git(team, ['remote', 'add', 'origin', remote]);
    assert.equal(git(team, ['push', '-u', 'origin', 'main']).status, 0);

    const preview = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team, '--stage', 'review', '--pr',
    ], root);
    assert.equal(preview.status, 0, preview.stderr + preview.stdout);
    assert.match(preview.stdout, /不改版本文件/);

    const result = run('hub-upstream.mjs', [
      '--root', root, '--to', 'team', '--team-library', team,
      '--stage', 'review', '--pr', '--apply', '--no-pr',
    ], root);
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const branch = git(team, ['branch', '--list', 'devflow/team-*', '--format=%(refname:short)'])
      .stdout.trim();
    assert.match(branch, /^devflow\/team-/);
    assert.match(
      git(team, ['show', `${branch}:.devflow/upstream-log.jsonl`]).stdout,
      /"mode":"team-pr"/,
    );

    assert.match(git(team, ['show', `${branch}:templates/stages/review/SKILL.md`]).stdout, /通用内容/);
    assert.notEqual(git(team, ['show', `${branch}:.claude-plugin/plugin.json`]).status, 0);
    assert.notEqual(git(team, ['show', `${branch}:CHANGELOG.md`]).status, 0);
    assert.doesNotMatch(git(team, ['show', '-s', '--format=%B', branch]).stdout, /版本：/);

    const pushed = git(remote, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.equal(git(team, ['status', '--porcelain']).stdout.trim(), '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 报告团队库路径问题并显示三个库', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-team-doctor-'));
  try {
    const root = makeProject(base);
    const hubFile = join(root, '.claude', 'hub', 'hub.yaml');
    const team = join(base, 'missing-team');
    writeFileSync(hubFile, `${readFileSync(hubFile, 'utf8')}\n`
      + 'templates:\n'
      + '  order: [team, personal, upstream]\n'
      + '  team:\n'
      + '    enabled: true\n'
      + `    path: ${team}\n`
      + '  personal:\n'
      + '    enabled: true\n');

    // support.mjs 设置了 DEVFLOW_TEAM_LIBRARY；doctor 按优先级会先读 env，这里显式清掉以验证 hub.yaml 路径。
    const env = { ...process.env };
    delete env.DEVFLOW_TEAM_LIBRARY;
    const doctor = (args) => spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-doctor.mjs'), ...args], {
      cwd: root, encoding: 'utf8', env,
    });

    const missing = doctor(['--root', root]);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stdout, /团队库不可用/);
    assert.match(missing.stdout, /团队模板库路径不存在/);
    assert.match(missing.stdout, /个人库：/);
    assert.match(missing.stdout, /上游库：/);

    mkdirSync(team, { recursive: true });
    const ok = doctor(['--root', root]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /团队库：/);
    assert.match(ok.stdout, /团队库不是 git 仓库/);
    assert.match(ok.stdout, /模板来源优先级：team > personal > upstream/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('旧项目未写 templates 块也能显式回灌到个人库', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-old-personal-'));
  try {
    const root = makeProject(base);
    const personal = join(base, 'personal');
    const result = run('hub-upstream.mjs', [
      '--root', root, '--to', 'personal', '--personal-library', personal, '--stage', 'review', '--apply',
    ], root);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(existsSync(join(personal, 'templates', 'stages', 'review', 'SKILL.md')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
