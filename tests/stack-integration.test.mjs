import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRemoteShipArgs } from '../scripts/hub-upstream.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
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
