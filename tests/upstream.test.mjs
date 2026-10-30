import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-up-'));
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
    '项目专属：内网地址 192.168.101.162，项目 api-gateway 的绝对路径 D:/work/api',
    '',
  ].join('\n'));
  writeFileSync(join(root, '.devflow.json'), JSON.stringify({ pluginRoot: PLUGIN_ROOT, pluginVersion: '1.0.0' }));
  writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
    'version: 1',
    'requiresPlugin: "^1.0.0"',
    'stages:',
    '  - review',
    'subprojects:',
    '  api-gateway:',
    '    path: services/api',
    '    stages: [review]',
    'defaults:',
    '  testCommand: "npm test"',
    'upstream:',
    '  blocklist: []',
    '',
  ].join('\n'));
  return root;
}

function makePluginCopy(base) {
  const copy = join(base, 'plugin');
  mkdirSync(copy, { recursive: true });
  cpSync(join(PLUGIN_ROOT, '.claude-plugin'), join(copy, '.claude-plugin'), { recursive: true });
  cpSync(join(PLUGIN_ROOT, 'templates'), join(copy, 'templates'), { recursive: true });
  writeFileSync(join(copy, 'CHANGELOG.md'), '# Changelog\n');
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'devflow', version: '1.0.0' }, null, 2));
  const manifest = join(copy, '.claude-plugin', 'plugin.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: '1.0.0' }, null, 2));
  const market = join(copy, '.claude-plugin', 'marketplace.json');
  const marketData = JSON.parse(readFileSync(market, 'utf8'));
  marketData.metadata = { ...(marketData.metadata || {}), version: '1.0.0' };
  writeFileSync(market, JSON.stringify(marketData, null, 2));
  return copy;
}

test('回灌预览：识别项目专属内容且不写插件', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    const before = readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8');
    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[项目专属\]/);
    assert.match(result.stdout, /预览完成/);
    assert.match(result.stdout, /0 个可回灌/);
    assert.equal(readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌 apply：写入模板、bump 版本、更新 CHANGELOG', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    // 去掉项目专属内容，使其可回灌。
    const skill = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');
    writeFileSync(skill, '---\nname: review\ndescription: 审查\n---\n\n通用内容：先看正确性。\n');
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

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /已回灌 1 个文件/);

    const template = readFileSync(join(pluginCopy, 'templates', 'stages', 'review', 'SKILL.md'), 'utf8');
    assert.match(template, /先看正确性/);

    const plugin = JSON.parse(readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '1.0.1');

    // 版本升级要同步到 package.json 与 marketplace
    const pkg = JSON.parse(readFileSync(join(pluginCopy, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.0.1');
    const market = JSON.parse(readFileSync(join(pluginCopy, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(market.metadata.version, '1.0.1');

    const changelog = readFileSync(join(pluginCopy, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /1\.0\.1/);
    assert.ok(existsSync(join(pluginCopy, 'templates', 'stages', '_feedback-log.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌递归处理阶段资源目录', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    const refDir = join(root, '.claude', 'hub', 'stages', 'review', 'references');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'extra.md'), '通用参考：先验证再判断。\n');

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /review\/references\/extra\.md/);
    assert.match(result.stdout, /已回灌 1 个文件/);

    const dst = join(pluginCopy, 'templates', 'stages', 'review', 'references', 'extra.md');
    assert.equal(readFileSync(dst, 'utf8'), '通用参考：先验证再判断。\n');

    const log = readFileSync(join(pluginCopy, 'templates', 'stages', '_feedback-log.md'), 'utf8');
    assert.match(log, /references\/extra\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌缺少 --stage 时报错', () => {
  const root = makeProject();
  try {
    const result = run('hub-upstream.mjs', ['--root', root], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--stage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌不因子项目名是其他单词的子串而误判', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), [
      '---', 'name: review', 'description: 审查', '---', '',
      'rapid prototyping 与 capital 的通用做法。',
      '',
    ].join('\n'));
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects:', '  api:', '    path: services/api', '    stages: [review]',
      'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[可回灌\]/);
    assert.doesNotMatch(result.stdout, /子项目名 api/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌跳过备份与临时文件', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '---\nname: review\ndescription: 审查\n---\n\n通用内容。\n');
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));
    const stageDir = join(root, '.claude', 'hub', 'stages', 'review');
    writeFileSync(join(stageDir, 'SKILL.md.bak-20260101'), '备份内容\n');
    writeFileSync(join(stageDir, 'SKILL.md.tmp-1234'), '临时内容\n');
    writeFileSync(join(stageDir, '.DS_Store'), 'x');

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy], root);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\.bak-|\.tmp-|\.DS_Store/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌重复执行是幂等的，不重复升级版本', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '---\nname: review\ndescription: 审查\n---\n\n通用内容。\n');
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));

    const first = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(first.status, 0, first.stderr);
    const second = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /一致|未修改/);

    const plugin = JSON.parse(readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '1.0.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌支持 --bump minor', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), '---\nname: review\ndescription: 审查\n---\n\n通用内容。\n');
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply', '--bump', 'minor'], root);
    assert.equal(result.status, 0, result.stderr);
    const plugin = JSON.parse(readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.version, '1.1.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌拒绝无法识别的 --bump', () => {
  const root = makeProject();
  try {
    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--bump', 'huge'], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--bump/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌把含 URL 的通用内容判为可回灌，不误伤 http(s)://', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    const skill = join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md');
    writeFileSync(skill, [
      '---', 'name: review', 'description: 审查', '---', '',
      '参考 https://example.com/guide 与 https://github.com/org/repo 的通用做法。',
      '',
    ].join('\n'));
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[可回灌\]/);
    assert.match(result.stdout, /已回灌 1 个文件/);

    const template = readFileSync(join(pluginCopy, 'templates', 'stages', 'review', 'SKILL.md'), 'utf8');
    assert.match(template, /https:\/\/example\.com\/guide/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
