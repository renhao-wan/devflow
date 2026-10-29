import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPluginRoot, resolveUpstreamRoot } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const STAGES = ['req', 'plan', 'implement', 'test', 'review', 'debug'];

function makePlugin(dir, version = '1.0.0') {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version }, null, 2));
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n');
  for (const stage of STAGES) {
    const file = join(dir, 'templates', 'stages', stage, 'SKILL.md');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `---\nname: ${stage}\ndescription: ${stage}\n---\n\n${stage} 模板\n`);
  }
  return dir;
}

function withEnv(value, fn) {
  const prev = process.env.CLAUDE_PLUGIN_ROOT;
  if (value === null) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = prev;
  }
}

test('缓存里的旧插件根优先让位给当前会话的 CLAUDE_PLUGIN_ROOT', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-root-'));
  try {
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    const oldCache = makePlugin(join(base, '.claude', 'plugins', 'cache', 'mp', 'devflow', '1.0.0'));
    const current = makePlugin(join(base, '.claude', 'plugins', 'cache', 'mp', 'devflow', '2.0.0'));
    writeFileSync(join(project, '.devflow.json'), JSON.stringify({ pluginRoot: oldCache }, null, 2));

    withEnv(current, () => {
      assert.equal(findPluginRoot(project), current);
    });
    withEnv(null, () => {
      assert.equal(findPluginRoot(project), oldCache);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('记录的插件根失效时回退到环境变量或向上查找', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-root-stale-'));
  try {
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.devflow.json'), JSON.stringify({
      pluginRoot: join(base, 'gone', 'devflow'),
    }, null, 2));
    const envRoot = makePlugin(join(base, 'env-plugin'));

    withEnv(envRoot, () => {
      assert.equal(findPluginRoot(project), envRoot);
    });
    withEnv(null, () => {
      assert.throws(() => findPluginRoot(project), /找不到 devflow 插件目录/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('回灌目标优先使用 pluginSourceRoot，显式参数再优先', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-source-'));
  try {
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    const source = makePlugin(join(base, 'source'));
    const explicit = makePlugin(join(base, 'explicit'));
    writeFileSync(join(project, '.devflow.json'), JSON.stringify({
      pluginRoot: makePlugin(join(base, '.claude', 'plugins', 'cache', 'mp', 'devflow', '1.0.0')),
      pluginSourceRoot: source,
    }, null, 2));

    withEnv(null, () => {
      assert.equal(resolveUpstreamRoot(project), source);
      assert.equal(resolveUpstreamRoot(project, explicit), explicit);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init --source-root 会持久化 pluginSourceRoot', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-init-source-'));
  try {
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
    const source = makePlugin(join(base, 'source'));

    const r = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-init.mjs'),
      '--root', project, '--plugin-root', source, '--source-root', source], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const meta = JSON.parse(readFileSync(join(project, '.devflow.json'), 'utf8'));
    assert.equal(meta.pluginSourceRoot, source);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('回灌拒绝写入 marketplace 安装缓存', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-cache-guard-'));
  try {
    const project = join(base, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
    const cache = makePlugin(join(base, '.claude', 'plugins', 'cache', 'mp', 'devflow', '1.0.0'));

    const init = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-init.mjs'),
      '--root', project, '--plugin-root', cache], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr + init.stdout);

    writeFileSync(join(project, '.claude', 'hub', 'stages', 'req', 'SKILL.md'),
      '---\nname: req\ndescription: 需求\n---\n\n通用规则\n');

    const r = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-upstream.mjs'),
      '--root', project, '--stage', 'req', '--apply', '--plugin-root', cache], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /回灌目标落在安装缓存/);
    assert.match(r.stderr, /--plugin-root/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
