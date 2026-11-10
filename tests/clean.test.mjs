import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOADERS } from '../scripts/lib/loaders.mjs';
import { gitignoreBlock } from '../scripts/lib/managed-artifacts.mjs';
import { defaultOps, runClean } from '../scripts/hub-clean.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-clean.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function write(rel, text = 'x') {
  const abs = join(CURRENT.root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

let CURRENT = {};

function makeWorkspace(base) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  CURRENT = { root };
  write('.claude/hub/hub.yaml', 'version: 1\n');
  write('.claude/hub/stages/req/SKILL.md', '# req\n');
  write('.claude/skills/devflow-req/SKILL.md', '# projected\n');
  write('.claude/.hub-manifest.json', '{}');
  write('.claude/.hub-sources.json', '{}');
  write('.claude/.hub-bases/stages/req/SKILL.md', '# base\n');
  write('.claude/.stack-sources.json', '{"packs":{}}');
  write('.claude/.stack-bases/java-spring/_shared.md', '# base\n');
  write('.claude/.stack-staging/tmp', 'x');
  write('.claude/.devflow-state.json', '{}');
  write('.claude/.ecosystem-state.json', '{}');
  write('.claude/.stack-trash/20260101/java-spring/_shared.md', '# backup\n');
  for (const file of Object.keys(LOADERS)) write(`scripts/${file}`, '// loader\n');
  write('.devflow.json', '{"pluginRoot":"x"}');
  write('docs/devflow/add-login/req.md', '# req\n');
  write('docs/upstream-log.md', '# log\n');
  write('src/app.js', 'console.log(1)\n');
  writeFileSync(join(root, '.gitignore'), `node_modules/\n${gitignoreBlock()}`);
  return root;
}

function withWorkspace(fn) {
  const base = mkdtempSync(join(tmpdir(), 'devflow-clean-'));
  try {
    return fn(makeWorkspace(base));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('默认是预览：不删除任何文件并列出将删除项', () => withWorkspace((root) => {
  const res = run(['--root', root], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /预览/);
  assert.match(res.stdout, /\.claude\/\.hub-manifest\.json/);
  assert.ok(existsSync(join(root, '.claude', '.hub-manifest.json')));
  assert.ok(existsSync(join(root, 'scripts', 'devflow-gen.mjs')));
}));

test('--apply 默认档删除生成物，保留 hub、docs 与 stack 备份', () => withWorkspace((root) => {
  const res = run(['--root', root, '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  for (const rel of [
    '.claude/skills/devflow-req/SKILL.md',
    '.claude/.hub-manifest.json',
    '.claude/.hub-sources.json',
    '.claude/.hub-bases/stages/req/SKILL.md',
    '.claude/.stack-sources.json',
    '.claude/.stack-bases/java-spring/_shared.md',
    '.claude/.stack-staging/tmp',
    '.claude/.devflow-state.json',
    '.claude/.ecosystem-state.json',
    '.devflow.json',
    'scripts/devflow-gen.mjs',
  ]) {
    assert.equal(existsSync(join(root, ...rel.split('/'))), false, `${rel} 应被删除`);
  }
  assert.ok(existsSync(join(root, '.claude', 'hub', 'hub.yaml')), '默认档应保留 hub');
  assert.ok(existsSync(join(root, 'docs', 'devflow', 'add-login', 'req.md')), '默认档应保留任务记录');
  assert.ok(existsSync(join(root, '.claude', '.stack-trash', '20260101', 'java-spring', '_shared.md')), '应保留 stack 备份');
  assert.ok(existsSync(join(root, 'src', 'app.js')), '不应碰用户文件');
}));

test('--apply 把删除项移入 .devflow-trash 备份', () => withWorkspace((root) => {
  const res = run(['--root', root, '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const trashRoot = join(root, '.claude', '.devflow-trash');
  assert.ok(existsSync(trashRoot));
  const stamp = readdirSync(trashRoot)[0];
  assert.ok(stamp, 'trash 下应有时间戳目录');
  assert.ok(existsSync(join(trashRoot, stamp, '.claude', '.hub-manifest.json')), '备份应保留相对路径');
}));

test('--hub 追加删除项目真源', () => withWorkspace((root) => {
  const res = run(['--root', root, '--hub', '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(existsSync(join(root, '.claude', 'hub')), false);
  assert.ok(existsSync(join(root, 'docs', 'devflow', 'add-login', 'req.md')));
}));

test('--docs 追加删除任务记录，但保留回灌日志', () => withWorkspace((root) => {
  const res = run(['--root', root, '--docs', '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(existsSync(join(root, 'docs', 'devflow')), false);
  assert.ok(existsSync(join(root, 'docs', 'upstream-log.md')), '回灌日志不属于任务记录');
  assert.ok(existsSync(join(root, '.claude', 'hub', 'hub.yaml')), '--docs 不应删除 hub');
}));

test('--all 删除生成物、hub 与任务记录，仍保留 stack 备份', () => withWorkspace((root) => {
  const res = run(['--root', root, '--all', '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(existsSync(join(root, '.claude', 'hub')), false);
  assert.equal(existsSync(join(root, 'docs', 'devflow')), false);
  assert.ok(existsSync(join(root, '.claude', '.stack-trash')), 'stack 备份始终保留');
}));

test('只摘除 .gitignore 的 devflow 块，保留用户内容', () => withWorkspace((root) => {
  const res = run(['--root', root, '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const text = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(text, /^node_modules\/\n/);
  assert.doesNotMatch(text, /devflow/);
}));

test('.gitignore 没有 devflow 块时保持原样', () => withWorkspace((root) => {
  const before = 'node_modules/\ndist/\n';
  writeFileSync(join(root, '.gitignore'), before);
  const res = run(['--root', root, '--apply'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), before);
}));

test('没有 devflow 锚点的目录退出 0 且不删除', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-clean-empty-'));
  try {
    writeFileSync(join(base, '.gitignore'), 'node_modules/\n');
    const res = run(['--root', base, '--apply'], base);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout + res.stderr, /未发现|没有/);
    assert.ok(existsSync(join(base, '.gitignore')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('重复执行保持幂等', () => withWorkspace((root) => {
  const first = run(['--root', root, '--apply'], root);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const second = run(['--root', root, '--apply'], root);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /没有可删除|已完成/);
}));

test('拒绝用户主目录作为清理根', () => withWorkspace((root) => {
  // 把 fixture 伪装成主目录：锚点齐全，但清理必须拒绝。
  const res = run(['--root', root, '--apply'], root, {
    HOME: root,
    USERPROFILE: root,
  });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr + res.stdout, /主目录|危险/);
  assert.ok(existsSync(join(root, '.claude', 'hub', 'hub.yaml')));
}));

test('--json 输出结构化预览', () => withWorkspace((root) => {
  const res = run(['--root', root, '--json'], root);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const report = JSON.parse(res.stdout);
  assert.equal(report.applied, false);
  assert.ok(report.delete.includes('.claude/.hub-manifest.json'));
  assert.ok(!report.delete.includes('.claude/hub'));
}));

test('rename 失败时逆序回滚并恢复 .gitignore', () => withWorkspace((root) => {
  const before = readFileSync(join(root, '.gitignore'), 'utf8');
  let calls = 0;
  const ops = {
    ...defaultOps,
    rename: (from, to) => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return defaultOps.rename(from, to);
    },
  };
  assert.throws(() => runClean({ root, flags: { apply: true }, ops, out: () => {} }), /locked/);
  assert.ok(existsSync(join(root, '.claude', '.hub-manifest.json')), '已移动项应回滚');
  assert.ok(existsSync(join(root, 'scripts', 'devflow-gen.mjs')));
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), before);
}));

test('删除目标经过 junction 指向项目外时拒绝', { skip: process.platform !== 'win32' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-clean-junction-'));
  const outside = join(base, 'outside');
  try {
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.md'), 'keep\n');
    const root = makeWorkspace(base);
    rmSync(join(root, '.claude', 'skills', 'devflow-req'), { recursive: true, force: true });
    symlinkSync(outside, join(root, '.claude', 'skills', 'devflow-req'), 'junction');
    const res = run(['--root', root, '--apply'], root);
    assert.notEqual(res.status, 0, '越界目标应导致失败');
    assert.ok(existsSync(join(outside, 'keep.md')), '项目外文件不得被删除');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
