import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRemoteShipArgs } from '../scripts/hub-upstream.mjs';
import { contentHash } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const NODE = process.execPath;

function run(script, args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function makeProject(base) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
  const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return root;
}

test('sync 跳过受管栈路径，不用模板库覆盖 pack', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# pack content\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0', files: {},
        },
      },
    }));
    // 受管路径下的旧记录不能被误报为“模板已移除”。
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: {
        '.claude/hub/stacks/java-spring/old.md': { base: 'x', local: 'x', source: 'upstream' },
      },
    }));
    // 使用独立 plugin fixture，避免修改仓库模板。
    // 版本必须满足 makeProject 写出的 requiresPlugin（^<当前版本>），否则 sync 会在版本门禁处失败。
    const fixture = join(base, 'plugin');
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fixture, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version: PLUGIN_VERSION }));
    mkdirSync(join(fixture, 'templates', 'stages', 'req'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stages', 'req', 'SKILL.md'), '---\nname: req\ndescription: req\n---\n\nreq\n');
    mkdirSync(join(fixture, 'templates', 'stacks', 'java-spring'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stacks', 'java-spring', '_shared.md'), '# template content\n');

    // --force：若未跳过受管路径，会直接覆盖 pack，确保测试能抓住回归。
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', fixture, '--no-gen', '--force'], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(dir, '_shared.md'), 'utf8'), /pack content/);
    assert.match(sync.stdout, /受管栈 java-spring/);
    assert.doesNotMatch(sync.stdout, /stacks\/java-spring\/_shared\.md/);
    assert.doesNotMatch(sync.stdout, /模板已移除/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('upstream --all 与 ship --all 排除受管栈，显式 --stack 拒绝', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-upstream-'));
  try {
    const root = makeProject(base);
    // makeProject 用 --no-draft 初始化，_shared 目录为空；补一个文件让 --all 能走到技术栈检查。
    writeFileSync(join(root, '.claude', 'hub', '_shared', 'project-basics.md'), '# 共享规则\n');
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# pack content\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0', files: {},
        },
      },
    }));
    const all = run('hub-upstream.mjs', ['--root', root, '--all'], root);
    assert.equal(all.status, 0, all.stderr + all.stdout);
    assert.doesNotMatch(all.stdout, /java-spring 技术栈/);
    assert.match(all.stdout, /受管栈 java-spring/);

    const explicit = run('hub-upstream.mjs', ['--root', root, '--stack', 'java-spring'], root);
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /stack pack 管理/);

    const allowed = run('hub-upstream.mjs', ['--root', root, '--stack', 'java-spring', '--allow-fork'], root);
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    // 放行后必须真正进入计划，而不是被静默跳过。
    assert.match(allowed.stdout, /java-spring 技术栈/);
    assert.doesNotMatch(allowed.stdout, /受管栈 java-spring/);

    const shipExplicit = run('hub-ship.mjs', ['--root', root, '--stack', 'java-spring'], root);
    assert.notEqual(shipExplicit.status, 0);
    assert.match(shipExplicit.stderr, /stack pack 管理/);

    // ship 侧的放行检查只断言不再命中受管错误；其余环境错误不在本测试范围。
    const shipAllowed = run('hub-ship.mjs', ['--root', root, '--stack', 'java-spring', '--allow-fork', '--dry-run'], root);
    assert.doesNotMatch(shipAllowed.stderr, /stack pack 管理/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('upstream --pr 委托 ship 时透传 --allow-fork', () => {
  const opts = {
    root: '/project',
    pluginRoot: '/plugin',
    units: [{ kind: 'stack', name: 'java-spring' }],
    target: { kind: 'upstream', pr: true },
  };
  const withFork = buildRemoteShipArgs(['--allow-fork', '--apply'], opts);
  assert.ok(withFork.includes('--allow-fork'), withFork.join(' '));
  assert.ok(withFork.includes('--stack'));
  assert.equal(withFork.includes('--dry-run'), false);
  const without = buildRemoteShipArgs(['--apply'], opts);
  assert.equal(without.includes('--allow-fork'), false);
});

test('账本损坏时 sync fail closed', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-gen'], root);
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 报告受管栈缺失文件与陈旧 hub-sources 记录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0',
          files: {
            '.claude/hub/stacks/java-spring/_shared.md': { base: 'x', local: 'x' },
            '.claude/hub/stacks/java-spring/plan.md': { base: 'y', local: 'y' },
          },
        },
      },
    }));
    writeFileSync(join(dir, '_shared.md'), '# local edit\n');
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: { '.claude/hub/stacks/java-spring/_shared.md': { base: 'z', local: 'z' } },
    }));
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /plan\.md.*缺失|缺失.*plan\.md/);
    assert.match(res.stdout, /陈旧/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在账本损坏时报错', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在没有受管栈时保持正常', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-empty-'));
  try {
    const root = makeProject(base);
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /没有受管的技术栈包/);
    assert.doesNotMatch(res.stdout, /未安装的包/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在账本为空时仍报告 stack-lock.yaml 的孤立条目', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-ghost-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {},
    }));
    writeFileSync(join(root, '.claude', 'hub', 'stack-lock.yaml'), [
      'version: 1',
      'packs:',
      '  ghost:',
      '    installedAs: ghost',
      "    repo: 'https://example.com/packs.git'",
      '    packId: ghost',
      '    path: stacks/ghost',
      '    ref: main',
      `    commit: ${'a'.repeat(40)}`,
      "    version: '1.0.0'",
      '',
    ].join('\n'));
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /stack-lock\.yaml 记录了未安装的包 ghost/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor --check-remote 报告落后 commit，默认不联网', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-remote-'));
  try {
    const root = makeProject(base);
    const repo = join(base, 'remote');
    mkdirSync(repo, { recursive: true });
    const g = (args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr + res.stdout);
    };
    g(['init', '-b', 'main']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    const writePack = (text) => {
      const packDir = join(repo, 'stacks', 'java-spring');
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, '_shared.md'), text);
      writeFileSync(join(packDir, 'stack.json'), JSON.stringify({
        name: 'java-spring', version: '1.2.0', minDevflow: '>=1.7.0',
        detects: ['java-maven'], files: { '_shared.md': contentHash(text) },
      }));
      writeFileSync(join(repo, 'index.json'), JSON.stringify({
        schemaVersion: 1,
        packs: { 'java-spring': { path: 'stacks/java-spring', detects: ['java-maven'] } },
      }));
      g(['add', '.']);
      g(['commit', '-m', 'pack']);
    };
    writePack('# shared v1\n');
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', [
      'add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen',
    ], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);

    // 默认 doctor 不碰网络：给一个全新缓存目录，运行后应仍不存在。
    const quietCache = join(base, 'quiet-cache');
    const quiet = run('hub-doctor.mjs', ['--root', root], root, {
      DEVFLOW_CACHE_DIR: quietCache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1',
    });
    assert.equal(quiet.status, 0, quiet.stderr + quiet.stdout);
    assert.doesNotMatch(quiet.stdout, /落后/);
    assert.equal(existsSync(quietCache), false);

    writePack('# shared v2\n');
    const checked = run('hub-doctor.mjs', ['--root', root, '--check-remote'], root, env);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.match(checked.stdout, /落后/);
    assert.match(checked.stdout, /stack update/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
