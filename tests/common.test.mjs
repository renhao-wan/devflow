import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml, parseFrontmatter, satisfies, bumpPatch, sha256, argValue, loadHub } from '../scripts/lib/common.mjs';

test('parseYaml 解析嵌套 map、块列表与行内列表', () => {
  const config = parseYaml(`
version: 1
requiresPlugin: "^1.0.0"
stages:
  - req
  - plan
subprojects:
  api:
    path: services/api
    stages: [plan, implement, test]
    testCommand: "npm test --workspace api"
defaults:
  reviewRequired: true
upstream:
  blocklist: []
`);
  assert.equal(config.version, 1);
  assert.equal(config.requiresPlugin, '^1.0.0');
  assert.deepEqual(config.stages, ['req', 'plan']);
  assert.equal(config.subprojects.api.path, 'services/api');
  assert.deepEqual(config.subprojects.api.stages, ['plan', 'implement', 'test']);
  assert.equal(config.subprojects.api.testCommand, 'npm test --workspace api');
  assert.equal(config.defaults.reviewRequired, true);
  assert.deepEqual(config.upstream.blocklist, []);
});

test('parseYaml 忽略注释与空行，支持 inline 空对象', () => {
  const config = parseYaml(`
# 顶部注释
version: 2
subprojects: {}
upstream:
  blocklist: ["内部域名", api]
`);
  assert.equal(config.version, 2);
  assert.deepEqual(config.subprojects, {});
  assert.deepEqual(config.upstream.blocklist, ['内部域名', 'api']);
});

test('parseYaml 拒绝无法解析的行', () => {
  assert.throws(() => parseYaml('version: 1\nthis is not yaml\n'), /无法解析/);
});

test('parseFrontmatter 处理普通值与折叠符号', () => {
  const plain = parseFrontmatter('---\nname: devflow-req\ndescription: 一句话描述\n---\nbody');
  assert.equal(plain.name, 'devflow-req');
  assert.equal(plain.description, '一句话描述');

  const folded = parseFrontmatter('---\nname: x\ndescription: >-\n  第一行\n  第二行\n---\n');
  assert.equal(folded.description, '第一行 第二行');
});

test('satisfies 支持 ^ ~ 比较符与 *', () => {
  assert.equal(satisfies('1.2.3', '^1.0.0'), true);
  assert.equal(satisfies('2.0.0', '^1.0.0'), false);
  // ^0.x 按 semver 收紧 minor：^0.2.0 允许 <0.3.0，^0.0.3 只允许 0.0.3
  assert.equal(satisfies('0.2.4', '^0.2.0'), true);
  assert.equal(satisfies('0.5.0', '^0.2.0'), false);
  assert.equal(satisfies('0.9.0', '^0.2.3'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.2.5', '~1.2.0'), true);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('1.0.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.0.0 <2.0.0'), false);
});

test('bumpPatch 与 sha256 稳定', () => {
  assert.equal(bumpPatch('1.2.9'), '1.2.10');
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('b'));
});

test('argValue 不把后续开关当成参数值', () => {
  assert.equal(argValue(['--slug', 'add-login'], '--slug', 'fallback'), 'add-login');
  assert.equal(argValue(['--slug', '--json'], '--slug', 'fallback'), 'fallback');
  assert.equal(argValue(['--json', '--slug'], '--slug', 'fallback'), 'fallback');
  assert.equal(argValue(['--json'], '--slug', 'fallback'), 'fallback');
});

test('parseYaml 行内注释不误伤引号内 # 与词内 #', () => {
  const config = parseYaml([
    'testCommand: bar # 注释 "含引号"',
    'quoted: "a # b"',
    'hashInWord: a#b',
  ].join('\n'));
  assert.equal(config.testCommand, 'bar');
  assert.equal(config.quoted, 'a # b');
  assert.equal(config.hashInWord, 'a#b');
});

test('loadHub 缺少配置时提示先运行 init', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-hub-missing-'));
  try {
    assert.throws(() => loadHub(root), /先运行 \/devflow:init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
