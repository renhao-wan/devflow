import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
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
    // 使用独立 plugin fixture，避免修改仓库模板。
    // 版本必须满足 makeProject 写出的 requiresPlugin（^1.7.0），否则 sync 会在版本门禁处失败。
    const fixture = join(base, 'plugin');
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fixture, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version: '1.7.0' }));
    mkdirSync(join(fixture, 'templates', 'stages', 'req'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stages', 'req', 'SKILL.md'), '---\nname: req\ndescription: req\n---\n\nreq\n');
    mkdirSync(join(fixture, 'templates', 'stacks', 'java-spring'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stacks', 'java-spring', '_shared.md'), '# template content\n');

    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', fixture, '--no-gen'], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(dir, '_shared.md'), 'utf8'), /pack content/);
    assert.match(sync.stdout, /受管栈 java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('账本损坏时 sync fail closed', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-gen'], root);
    assert.notEqual(sync.status, 0);
    assert.match(sync.stderr, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
