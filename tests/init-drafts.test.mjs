import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DRAFT_MARKER } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function makeRoot(files = ['package.json']) {
  const root = mkdtempSync(join(tmpdir(), 'devflow-init-drafts-'));
  for (const rel of files) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    const content = rel.endsWith('package.json')
      ? JSON.stringify({ name: rel, scripts: { test: 'node --test' } })
      : '<project/>';
    writeFileSync(abs, content);
  }
  return root;
}

const read = (root, rel) => readFileSync(join(root, ...rel.split('/')), 'utf8');
const has = (root, rel) => existsSync(join(root, ...rel.split('/')));

test('单栈 init 自动声明 stack 并生成通用与栈草稿', () => {
  const root = makeRoot();
  try {
    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.match(read(root, '.claude/hub/hub.yaml'), /^stack: "nodejs"$/m);
    assert.match(init.stdout, /探测到单一技术栈 nodejs/);

    for (const rel of ['.claude/hub/_shared/project-basics.md', '.claude/hub/stacks/nodejs/_shared.md']) {
      assert.ok(has(root, rel), `缺少草稿 ${rel}`);
      assert.ok(read(root, rel).startsWith(DRAFT_MARKER), `${rel} 缺少草稿标记`);
    }

    // 草稿不是规则：不进入投影路径列表，也不进入共享规则账本。
    const projection = read(root, '.claude/skills/devflow-req/SKILL.md');
    assert.match(projection, /nodejs/);
    assert.doesNotMatch(projection, /stacks\/nodejs\/_shared\.md/);
    const manifest = JSON.parse(read(root, '.claude/.hub-manifest.json'));
    assert.deepEqual(manifest.shared, []);

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    // 草稿待填写是 INFO：正常展示，但不计入提醒与建议。
    assert.match(doctor.stdout, /\[INFO\] 2 个规则草稿待填写/);
    assert.match(doctor.stdout, /0 个错误，0 个提醒，/);
    assert.doesNotMatch(doctor.stdout, /建议：/);

    assert.equal(run('gen-claude-skills.mjs', ['--root', root, '--check'], root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('默认只生成草稿并提示智能补全需要 --draft', () => {
  const root = makeRoot();
  try {
    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.match(init.stdout, /草稿已生成；智能补全仅在 \/devflow:init --draft 中执行/);
    assert.match(init.stdout, /1\. 直接开始：\/devflow:req <需求>/);
    assert.match(init.stdout, /（可选）填写 \.claude\/hub\/_shared\/project-basics\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--draft 输出技能补全文案，已初始化时补草稿同样如此', () => {
  const root = makeRoot();
  try {
    const first = run('hub-init.mjs', ['--root', root, '--draft'], root);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /已按 --draft 生成草稿；通过 \/devflow:init --draft 调用时由技能补全 TODO/);
    assert.doesNotMatch(first.stdout, /智能补全仅在/);

    // 已初始化分支补生成草稿时，也按 --draft 区分文案。
    rmSync(join(root, '.claude', 'hub', '_shared', 'project-basics.md'), { force: true });
    const again = run('hub-init.mjs', ['--root', root, '--draft'], root);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /补生成规则草稿 \.claude\/hub\/_shared\/project-basics\.md/);
    assert.match(again.stdout, /已按 --draft 生成草稿；通过 \/devflow:init --draft 调用时由技能补全 TODO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--draft 与 --no-draft 互斥', () => {
  const root = makeRoot();
  try {
    const result = run('hub-init.mjs', ['--root', root, '--draft', '--no-draft'], root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--draft 与 --no-draft 不能同时使用/);
    assert.equal(has(root, '.claude/hub/hub.yaml'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('填写草稿并删除标记后，gen 把路径纳入投影', () => {
  const root = makeRoot();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const basics = '.claude/hub/_shared/project-basics.md';
    const stack = '.claude/hub/stacks/nodejs/_shared.md';
    writeFileSync(join(root, ...basics.split('/')), '# 项目基础规则\n\n- 提交前必须跑测试。\n');
    writeFileSync(join(root, ...stack.split('/')), '# Node.js 通用规范\n\n- 使用 ESM。\n');

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const projection = read(root, '.claude/skills/devflow-req/SKILL.md');
    assert.match(projection, /\.claude\/hub\/_shared\/project-basics\.md/);
    assert.match(projection, /\.claude\/hub\/stacks\/nodejs\/_shared\.md/);
    // 投影仍然只记录路径。
    assert.doesNotMatch(projection, /提交前必须跑测试/);

    const manifest = JSON.parse(read(root, '.claude/.hub-manifest.json'));
    assert.equal(manifest.shared.length, 1);
    assert.equal(manifest.shared[0].path, '.claude/hub/_shared/project-basics.md');

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /没有待填写的规则草稿/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--no-draft 不生成草稿、不自动声明 stack', () => {
  const root = makeRoot();
  try {
    const init = run('hub-init.mjs', ['--root', root, '--no-draft'], root);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.doesNotMatch(read(root, '.claude/hub/hub.yaml'), /^stack:/m);
    assert.equal(has(root, '.claude/hub/_shared/project-basics.md'), false);
    assert.equal(has(root, '.claude/hub/stacks/nodejs/_shared.md'), false);
    assert.match(init.stdout, /跳过规则草稿生成/);
    // 没有草稿时，下一步不再提示填写不存在的文件。
    assert.doesNotMatch(init.stdout, /project-basics\.md 中的 TODO/);
    assert.doesNotMatch(init.stdout, /技术栈草稿在/);
    assert.match(init.stdout, /2\. （可选）node scripts\/devflow-gen\.mjs/);

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.doesNotMatch(doctor.stdout, /规则草稿待填写/);
    assert.equal(run('gen-claude-skills.mjs', ['--root', root, '--check'], root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('多技术栈不自动声明 stack，只生成通用草稿', () => {
  const root = makeRoot(['package.json', 'pom.xml']);
  try {
    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.doesNotMatch(read(root, '.claude/hub/hub.yaml'), /^stack:/m);
    assert.ok(has(root, '.claude/hub/_shared/project-basics.md'));
    assert.equal(has(root, '.claude/hub/stacks/nodejs/_shared.md'), false);
    assert.equal(has(root, '.claude/hub/stacks/java-maven/_shared.md'), false);
    assert.match(init.stdout, /探测到多个技术栈（nodejs、java-maven）/);
    assert.match(init.stdout, /devflow-rule-placement/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('重复 init 与 --force 都不覆盖已填写的草稿', () => {
  const root = makeRoot();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const basics = '.claude/hub/_shared/project-basics.md';
    const stack = '.claude/hub/stacks/nodejs/_shared.md';
    const customBasics = '# 项目基础规则\n\n- 保留这条。\n';
    const customStack = '# Node.js 规范\n\n- 保留这条。\n';
    writeFileSync(join(root, ...basics.split('/')), customBasics);
    writeFileSync(join(root, ...stack.split('/')), customStack);

    const again = run('hub-init.mjs', ['--root', root], root);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(read(root, basics), customBasics);
    assert.equal(read(root, stack), customStack);

    const force = run('hub-init.mjs', ['--root', root, '--force'], root);
    assert.equal(force.status, 0, force.stdout + force.stderr);
    assert.equal(read(root, basics), customBasics);
    assert.equal(read(root, stack), customStack);
    // 已有的 stack 声明保留。
    assert.match(read(root, '.claude/hub/hub.yaml'), /^stack: "nodejs"$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init 不复制模板库草稿，也不写入源文件账本', () => {
  const root = makeRoot();
  const library = mkdtempSync(join(tmpdir(), 'devflow-init-library-draft-'));
  try {
    const rel = 'templates/stages/plan/references/draft.md';
    const abs = join(library, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, `${DRAFT_MARKER}\n# 模板草稿\n\n- TODO: 补充。\n`);

    const init = run('hub-init.mjs', ['--root', root, '--personal-library', library], root);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.equal(has(root, '.claude/hub/stages/plan/references/draft.md'), false);
    const sources = JSON.parse(read(root, '.claude/.hub-sources.json'));
    assert.equal(sources.files['.claude/hub/stages/plan/references/draft.md'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(library, { recursive: true, force: true });
  }
});

test('--force 不会用模板库同名文件覆盖草稿', () => {
  const root = makeRoot();
  const library = mkdtempSync(join(tmpdir(), 'devflow-init-library-'));
  try {
    for (const [rel, content] of Object.entries({
      'templates/shared/project-basics.md': '# 库里的共享规则\n\n- 来自模板库。\n',
      'templates/stacks/nodejs/_shared.md': '# 库里的 Node.js 规则\n\n- 来自模板库。\n',
    })) {
      const abs = join(library, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    }

    const first = run('hub-init.mjs', ['--root', root, '--personal-library', library], root);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const basics = '.claude/hub/_shared/project-basics.md';
    const stack = '.claude/hub/stacks/nodejs/_shared.md';
    // 模板库同名文件先落地，再模拟用户把它改成草稿。
    const customBasics = `${DRAFT_MARKER}\n# 我的基础规则\n\n- 保留这条。\n`;
    const customStack = `${DRAFT_MARKER}\n# 我的 Node.js 规则\n\n- 保留这条。\n`;
    writeFileSync(join(root, ...basics.split('/')), customBasics);
    writeFileSync(join(root, ...stack.split('/')), customStack);

    const force = run('hub-init.mjs', ['--root', root, '--personal-library', library, '--force'], root);
    assert.equal(force.status, 0, force.stdout + force.stderr);
    assert.equal(read(root, basics), customBasics);
    assert.equal(read(root, stack), customStack);
    assert.match(force.stdout, /保留已有草稿 2 个/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(library, { recursive: true, force: true });
  }
});

test('hub.yaml 损坏时 --force 先备份再重建', () => {
  const root = makeRoot();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const hub = join(root, '.claude', 'hub', 'hub.yaml');
    const broken = 'version: 1\nstages: [req]\nstages: [plan]\n';
    writeFileSync(hub, broken);

    const forced = run('hub-init.mjs', ['--root', root, '--force'], root);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.match(forced.stdout, /已备份/);
    assert.equal(readFileSync(`${hub}.bak`, 'utf8'), broken);
    assert.match(read(root, '.claude/hub/hub.yaml'), /^stages:$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
