import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hintPriority, renderHints } from '../scripts/hub-doctor.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function hints(entries) {
  return new Map(entries);
}

test('建议按修复顺序排序，不受加入顺序影响', () => {
  const rendered = renderHints(hints([
    ['devflow route --detect', []],
    ['node scripts/devflow-gen.mjs', []],
    ['/devflow:onboard', []],
    ['/devflow:init', []],
  ]));
  assert.deepEqual(rendered, [
    '建议：/devflow:init',
    '建议：node scripts/devflow-gen.mjs',
    '建议：/devflow:onboard',
    '建议：devflow route --detect',
  ]);
  assert.ok(hintPriority('/devflow:init') < hintPriority('/devflow:sync'));
  assert.ok(hintPriority('/devflow:sync') < hintPriority('node scripts/devflow-gen.mjs'));
});

test('init 系列建议合并为一行并保留具体原因', () => {
  const rendered = renderHints(hints([
    ['/devflow:init', ['缺少 .claude/.devflow.json，运行 /devflow:init 可重建']],
    ['/devflow:init --source-root <路径>', ['回灌源码仓库不存在：/tmp/old']],
  ]));
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /^建议：\/devflow:init；或 \/devflow:init --source-root <路径>/);
  assert.match(rendered[0], /缺少 \.claude\/\.devflow\.json/);
  assert.match(rendered[0], /回灌源码仓库不存在/);
});

test('单个原因不重复提醒正文', () => {
  const rendered = renderHints(hints([
    ['/devflow:init', ['缺少 .devflow.json，运行 /devflow:init 可重建']],
  ]));
  assert.deepEqual(rendered, ['建议：/devflow:init']);
});

test('合并后的原因最多展示三条并标注总数', () => {
  const rendered = renderHints(hints([
    ['/devflow:init', ['原因一', '原因二', '原因三', '原因四', '原因五']],
  ]));
  assert.match(rendered[0], /原因一；原因二；原因三 等 5 项/);
  assert.doesNotMatch(rendered[0], /原因四/);
});

test('未初始化项目的建议把 init 排在最前', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-hints-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const r = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-doctor.mjs'), '--root', root], {
      cwd: root,
      encoding: 'utf8',
    });
    const initLine = r.stdout.indexOf('建议：/devflow:init');
    const routeLine = r.stdout.indexOf('建议：devflow route --detect');
    assert.ok(initLine !== -1, r.stdout);
    assert.ok(routeLine !== -1, r.stdout);
    assert.ok(initLine < routeLine, r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('插件模式不输出项目建议', () => {
  const r = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-doctor.mjs')], {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /建议：/);
});
