import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DRAFT_MARKER } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-gen-drafts-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gen-drafts', scripts: { test: 'node --test' } }));
  return root;
}

function write(root, rel, content) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const read = (root, rel) => readFileSync(join(root, ...rel.split('/')), 'utf8');

function init(root) {
  const result = run('hub-init.mjs', ['--root', root, '--no-draft'], root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('gen 不把 overrides 与阶段资源草稿写进投影', () => {
  const root = makeRoot();
  try {
    init(root);
    const override = '.claude/hub/overrides/api/plan.md';
    const draftRef = '.claude/hub/stages/plan/references/draft.md';
    const realRef = '.claude/hub/stages/plan/references/real.md';
    write(root, override, `${DRAFT_MARKER}\n# 子项目覆盖草稿\n`);
    write(root, draftRef, `${DRAFT_MARKER}\n# 参考资料草稿\n`);
    write(root, realRef, '# 真实参考资料\n');

    const first = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const projection = read(root, '.claude/skills/devflow-plan/SKILL.md');
    assert.doesNotMatch(projection, /overrides\/api\/plan\.md/);
    assert.doesNotMatch(projection, /references\/draft\.md/);
    assert.match(projection, /references\/real\.md/);

    // 删除标记后，路径才进入投影。
    write(root, override, '# 子项目覆盖\n');
    write(root, draftRef, '# 参考资料\n');
    const second = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const updated = read(root, '.claude/skills/devflow-plan/SKILL.md');
    assert.match(updated, /overrides\/api\/plan\.md/);
    assert.match(updated, /references\/draft\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('阶段入口 SKILL.md 不允许草稿标记', () => {
  const root = makeRoot();
  try {
    init(root);
    const entry = '.claude/hub/stages/plan/SKILL.md';
    const original = read(root, entry);
    write(root, entry, `${DRAFT_MARKER}\n${original}`);

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 1, gen.stdout + gen.stderr);
    assert.match(gen.stdout + gen.stderr, /阶段入口不支持草稿/);
    // 旧投影保留，不会写入基于草稿的内容。
    assert.match(read(root, '.claude/skills/devflow-plan/SKILL.md'), /devflow \/ plan/);

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.match(doctor.stdout, /阶段入口 SKILL\.md 不支持草稿标记/);

    write(root, entry, original);
    const fixed = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
