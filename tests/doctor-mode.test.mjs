import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(args, cwd = PLUGIN_ROOT) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-doctor.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-doctor-mode-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  return root;
}

/** 只复制插件仓库检查需要的目录，避免把 .git 与本地工作区带进夹具。 */
function copyPluginRepo() {
  const base = mkdtempSync(join(tmpdir(), 'devflow-plugin-repo-'));
  const repo = join(base, 'plugin');
  mkdirSync(repo, { recursive: true });
  for (const rel of ['.claude-plugin', 'hooks', 'scripts', 'skills', 'templates']) {
    cpSync(join(PLUGIN_ROOT, rel), join(repo, rel), { recursive: true });
  }
  copyFileSync(join(PLUGIN_ROOT, 'package.json'), join(repo, 'package.json'));
  return { base, repo };
}

function editJson(file, mutate) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  mutate(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

test('插件源码仓库自动进入插件模式，INFO 不增加提醒', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\[INFO\] 插件源码仓库模式/);
  assert.match(r.stdout, /0 个错误，0 个提醒，1 条提示。/);
  assert.doesNotMatch(r.stdout, /请先运行 \/devflow:init/);
  assert.doesNotMatch(r.stderr, /未知参数/);
});

test('插件模式跳过每一类项目工作区检查', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 逐项断言：插件仓库没有 hub 工作区，也不应出现任何项目配置提醒。
  assert.doesNotMatch(r.stdout, /hub\.yaml/);
  assert.doesNotMatch(r.stdout, /\.devflow\.json/);
  assert.doesNotMatch(r.stdout, /缺少 loader|loader 内容过期/);
  assert.doesNotMatch(r.stdout, /\.gitignore/);
  assert.doesNotMatch(r.stdout, /项目概览/);
  assert.doesNotMatch(r.stdout, /测试命令依赖/);
  assert.doesNotMatch(r.stdout, /\.hub-sources\.json|阶段源账本/);
  assert.doesNotMatch(r.stdout, /\.hub-manifest\.json|生成账本/);
  assert.doesNotMatch(r.stdout, /ecosystem\.yaml|\.ecosystem-state\.json/);
  assert.doesNotMatch(r.stdout, /模板库|个人库|团队库/);
  assert.doesNotMatch(r.stdout, /尚未验证|测试通过/);
});

test('插件模式 JSON 输出 mode 与 info 行', () => {
  const r = run(['--json']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, 'plugin');
  assert.ok(report.rows.some((row) => row.status === 'info'));
  assert.equal(report.rows.filter((row) => row.status === 'warn').length, 0);
});

test('--mode project 在插件仓库按项目工作区检查', () => {
  const r = run(['--mode', 'project']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /请先运行 \/devflow:init/);
  assert.doesNotMatch(r.stdout, /\[INFO\] 插件源码仓库模式/);
});

test('--mode plugin 在普通目录报错并指出缺少插件清单', () => {
  const root = makeProject();
  try {
    const r = run(['--root', root, '--mode', 'plugin']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /不是 devflow 插件源码仓库/);
    assert.doesNotMatch(r.stdout, /请先运行 \/devflow:init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未初始化且不是插件仓库时保持项目模式错误', () => {
  const root = makeProject();
  try {
    const r = run(['--root', root, '--json']);
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.mode, 'project');
    assert.ok(report.rows.some((row) => /请先运行 \/devflow:init/.test(row.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同时存在 hub 与插件清单时 auto 优先项目模式', () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'version: 1\nstages:\n  - req\n');
    mkdirSync(join(root, '.claude-plugin'));
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version: '1.6.0' }));
    const r = run(['--root', root, '--json']);
    const report = JSON.parse(r.stdout);
    assert.equal(report.mode, 'project');
    assert.ok(!report.rows.some((row) => /插件源码仓库模式/.test(row.message)));
    // 双身份下提示仍可显式走插件自检，避免静默降级。
    assert.ok(report.rows.some((row) => row.status === 'info' && /--mode plugin/.test(row.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--mode plugin 在插件仓库显式走插件检查', () => {
  const r = run(['--mode', 'plugin', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, 'plugin');
  assert.ok(report.rows.some((row) => row.status === 'info' && /插件源码仓库模式/.test(row.message)));
  assert.equal(report.rows.filter((row) => row.status === 'warn').length, 0);
  assert.ok(!report.rows.some((row) => /请先运行 \/devflow:init/.test(row.message)));
});

test('--mode project 在已初始化的普通项目显式走项目检查', () => {
  const root = makeProject();
  try {
    const init = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-init.mjs'), '--root', root], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const r = run(['--root', root, '--mode', 'project', '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.mode, 'project');
    assert.ok(!report.rows.some((row) => /插件源码仓库模式/.test(row.message)));
    assert.ok(!report.rows.some((row) => /请先运行 \/devflow:init/.test(row.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('初始化后的项目自动进入项目模式', () => {
  const root = makeProject();
  try {
    const init = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-init.mjs'), '--root', root], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const r = run(['--root', root, '--json']);
    const report = JSON.parse(r.stdout);
    assert.equal(report.mode, 'project');
    assert.ok(!report.rows.some((row) => /插件源码仓库模式/.test(row.message)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marketplace 的 metadata.version 不参与插件版本校验', () => {
  const { base, repo } = copyPluginRepo();
  try {
    editJson(join(repo, '.claude-plugin', 'marketplace.json'), (data) => {
      data.metadata.version = '9.9.9';
    });
    const r = run(['--root', repo]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /插件版本一致/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('marketplace 中同名插件的 version 不一致时报错', () => {
  const { base, repo } = copyPluginRepo();
  try {
    editJson(join(repo, '.claude-plugin', 'marketplace.json'), (data) => {
      data.plugins.find((entry) => entry.name === 'devflow').version = '9.9.9';
    });
    const r = run(['--root', repo]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /插件版本不一致/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('插件模式检查 CLI 脚本、阶段模板与技能 frontmatter', () => {
  const { base, repo } = copyPluginRepo();
  try {
    rmSync(join(repo, 'scripts', 'trace.mjs'));
    rmSync(join(repo, 'templates', 'stages', 'debug'), { recursive: true, force: true });
    writeFileSync(
      join(repo, 'skills', 'init', 'SKILL.md'),
      '---\nname: wrong-name\ndescription: test\n---\n',
    );
    const r = run(['--root', repo]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CLI 命令脚本缺失：.*scripts\/trace\.mjs/);
    assert.match(r.stdout, /阶段模板缺失：.*templates\/stages\/debug\/SKILL\.md/);
    assert.match(r.stdout, /技能 frontmatter 与目录不一致：init（name 为 wrong-name）/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--mode 非法取值直接报错', () => {
  const r = run(['--mode', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--mode 只支持 auto、plugin 或 project/);
});
