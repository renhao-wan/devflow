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
    assert.equal((market.plugins || []).find((p) => p.name === 'devflow')?.version, '1.0.1');

    const changelog = readFileSync(join(pluginCopy, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /1\.0\.1/);
    assert.ok(existsSync(join(pluginCopy, 'templates', 'stages', '_feedback-log.md')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌在 CHANGELOG 缺少标题时仍写入版本条目', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
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
    writeFileSync(join(pluginCopy, 'CHANGELOG.md'), '历史内容\n');

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(result.status, 0, result.stderr);
    const changelog = readFileSync(join(pluginCopy, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /^# Changelog\n/);
    assert.match(changelog, /## 1\.0\.1/);
    assert.match(changelog, /历史内容/);
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

test('回灌把疑似密钥或凭据判为项目专属', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    const cases = [
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'api_key = sk-abcdefghijklmnopqrstuvwx',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'DATABASE_URL=postgres://user:secret@db.example.com/app',
      '-----BEGIN RSA PRIVATE KEY-----',
      // 带下划线的环境变量名不能被 \b 漏判
      'DB_PASSWORD=hunter2secret',
      'AWS_SECRET_ACCESS_KEY=abcdefghijklmnop',
      'MYSQL_ROOT_PASSWORD: rootpass123',
      'CLIENT_SECRET = abcdef123456',
    ];
    for (const line of cases) {
      writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'), [
        '---', 'name: review', 'description: 审查', '---', '', line, '',
      ].join('\n'));
      writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
        'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
        'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
      ].join('\n'));

      const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy], root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[项目专属\].*疑似密钥或凭据/, line);
      assert.doesNotMatch(result.stdout, /ghp_|sk-|Bearer |PRIVATE KEY|secret@/, '输出不应回显密钥原文');
    }
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

test('回灌中途失败后重跑会补齐版本，不重复升级', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 审查\n---\n\n通用内容：先看正确性。\n');
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));

    // 让 CHANGELOG 无法写入：模拟“模板已复制、版本已升级、收尾失败”。
    const changelog = join(pluginCopy, 'CHANGELOG.md');
    rmSync(changelog, { force: true });
    mkdirSync(changelog);

    const first = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(first.status, 1);
    assert.match(first.stderr, /EISDIR/);
    assert.equal(JSON.parse(readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.0.1');
    assert.ok(existsSync(join(pluginCopy, '.devflow-upstream-apply.json')), '应保留中断记录');

    rmSync(changelog, { recursive: true, force: true });
    const second = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(second.status, 0, second.stderr);

    // 重跑只补齐收尾，不会把 1.0.1 再升到 1.0.2
    assert.equal(JSON.parse(readFileSync(join(pluginCopy, '.claude-plugin', 'plugin.json'), 'utf8')).version, '1.0.1');
    assert.equal(existsSync(join(pluginCopy, '.devflow-upstream-apply.json')), false);
    assert.match(readFileSync(changelog, 'utf8'), /## 1\.0\.1/);

    const log = readFileSync(join(pluginCopy, 'templates', 'stages', '_feedback-log.md'), 'utf8');
    assert.equal((log.match(/devflow-apply:review:1\.0\.1/g) || []).length, 1, '回灌日志不应重复');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌遇到损坏的版本文件时报错而不是静默跳过', () => {
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 审查\n---\n\n通用内容：先看正确性。\n');
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));
    writeFileSync(join(pluginCopy, '.claude-plugin', 'marketplace.json'), '{ 损坏的 JSON');

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /无法解析版本文件/);
    assert.match(result.stderr, /marketplace\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('回灌拒绝通过 junction 写到插件目录外', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证 junction');
    return;
  }
  const root = makeProject();
  const pluginCopy = makePluginCopy(root);
  let junction = null;
  try {
    writeFileSync(join(root, '.claude', 'hub', 'stages', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: 审查\n---\n\n通用内容：先看正确性。\n');
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), [
      'version: 1', 'requiresPlugin: "^1.0.0"', 'stages:', '  - review',
      'subprojects: {}', 'defaults:', '  testCommand: "npm test"', 'upstream:', '  blocklist: []', '',
    ].join('\n'));

    const outside = join(root, 'outside');
    mkdirSync(outside);
    const stageTpl = join(pluginCopy, 'templates', 'stages', 'review');
    rmSync(stageTpl, { recursive: true, force: true });
    const link = spawnSync('cmd', ['/c', 'mklink', '/J', stageTpl, outside], { encoding: 'utf8' });
    if (link.status !== 0) {
      t.skip('mklink /J 不可用');
      return;
    }
    junction = stageTpl;

    const result = run('hub-upstream.mjs', ['--root', root, '--stage', 'review', '--plugin-root', pluginCopy, '--apply'], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /越界/);
    assert.equal(existsSync(join(outside, 'SKILL.md')), false);
  } finally {
    if (junction) spawnSync('cmd', ['/c', 'rmdir', junction], { encoding: 'utf8' });
    rmSync(root, { recursive: true, force: true });
  }
});
