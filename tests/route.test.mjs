import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultConfig, renderConfig, validateConfig, detectTools } from '../scripts/lib/ecosystem.mjs';
import { parseYaml } from '../scripts/lib/common.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'hub-route.mjs');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-route-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function run(root, home, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--home', home, ...args], {
    encoding: 'utf8',
  });
  const json = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null;
  return { ...r, json };
}

function addSkill(root, name) {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

function enablePlugin(root, name) {
  const file = join(root, '.claude', 'settings.json');
  mkdirSync(join(root, '.claude'), { recursive: true });
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [name]: true };
  writeFileSync(file, JSON.stringify(settings));
}

function writeEco(root, text) {
  const dir = join(root, '.claude', 'hub');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ecosystem.yaml'), text);
}

function detect(root, home) {
  const r = run(root, home, ['--detect', '--json']);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test('route 在未配置生态索引时回退 devflow', () => {
  const { root, home } = setup();
  try {
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'use-devflow');
    assert.match(r.json.reason, /未配置/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 在 mode=off 时不路由', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: "off"\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'use-devflow');
    assert.match(r.json.reason, /mode=off/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 在 ask 模式建议 technique 工具并解析技法入口', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: ask\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'suggest');
    assert.equal(r.json.tool.id, 'superpowers');
    assert.equal(r.json.tool.invoke, '/superpowers:brainstorming');
    assert.equal(r.json.constraints.keepStageGates, true);
    assert.equal(r.json.constraints.keepArtifacts, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 在 auto 模式只自动委派 technique 工具', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'delegate');
    assert.equal(r.json.tool.kind, 'technique');
    assert.equal(r.json.constraints.autoAllowed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 在 auto 模式对 workflow 工具只建议', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'bmad');
    writeEco(root, [
      'version: 1',
      'routing:',
      '  mode: auto',
      'tools:',
      '  bmad:',
      '    kind: workflow',
      '    stages: [req, plan, implement]',
    ].join('\n') + '\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'suggest');
    assert.equal(r.json.tool.id, 'bmad');
    assert.equal(r.json.constraints.autoAllowed, false);
    assert.match(r.json.reason, /workflow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 支持 --force-devflow 与 --no-route', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n');
    detect(root, home);
    for (const flag of ['--force-devflow', '--no-route']) {
      const r = run(root, home, ['--stage', 'plan', flag, '--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.json.decision, 'use-devflow');
      assert.match(r.json.reason, /强制使用 devflow/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 支持 --tool 强制指定，未检测到也执行并告警', () => {
  const { root, home } = setup();
  try {
    writeEco(root, 'version: 1\nrouting:\n  mode: ask\n');
    const r = run(root, home, ['--stage', 'plan', '--tool', 'superpowers', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'delegate');
    assert.equal(r.json.tool.id, 'superpowers');
    assert.ok(r.json.warnings.some((w) => w.includes('未检测到')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 拒绝未知或被禁用或不支持当前阶段的工具', () => {
  const { root, home } = setup();
  try {
    writeEco(root, [
      'version: 1',
      'routing:',
      '  mode: ask',
      'tools:',
      '  off-tool:',
      '    enabled: false',
      '    stages: [plan]',
      '  narrow:',
      '    kind: technique',
      '    stages: [plan]',
    ].join('\n') + '\n');

    const unknown = run(root, home, ['--stage', 'plan', '--tool', 'nope', '--json']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知工具/);

    const disabled = run(root, home, ['--stage', 'plan', '--tool', 'off-tool', '--json']);
    assert.equal(disabled.status, 1);
    assert.match(disabled.stderr, /已禁用/);

    const mismatch = run(root, home, ['--stage', 'test', '--tool', 'narrow', '--json']);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /未声明支持 test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 在未检测到任何工具时不自动选中', () => {
  const { root, home } = setup();
  try {
    writeEco(root, 'version: 1\nrouting:\n  mode: ask\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'use-devflow');
    assert.match(r.json.reason, /没有检测到/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 尊重 forceDevflowStages', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n  forceDevflowStages: [test]\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'test', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'use-devflow');
    assert.match(r.json.reason, /强制使用 devflow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route --detect 创建默认配置并写入检测状态', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    const r = detect(root, home);
    assert.equal(r.json.available.includes('superpowers'), true);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'ecosystem.yaml')), true);
    assert.equal(existsSync(join(root, '.claude', '.ecosystem-state.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 通过 settings.enabledPlugins 检测插件', () => {
  const { root, home } = setup();
  try {
    enablePlugin(root, 'bmad@marketplace');
    writeEco(root, [
      'version: 1',
      'routing:',
      '  mode: ask',
      'tools:',
      '  bmad:',
      '    kind: workflow',
      '    stages: [plan]',
    ].join('\n') + '\n');
    const r = detect(root, home);
    assert.equal(r.json.available.includes('bmad'), true);
    assert.deepEqual(r.json.tools.bmad.signals, ['plugin:bmad']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 在配置解析失败时 fail-open', () => {
  const { root, home } = setup();
  try {
    writeEco(root, 'version: 1\nrouting:\n  mode\n');
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'use-devflow');
    assert.match(r.stderr, /解析失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route --list --json 汇总模式与工具状态', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: ask\n');
    detect(root, home);
    const r = run(root, home, ['--list', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.mode, 'ask');
    assert.equal(r.json.tools.find((t) => t.id === 'superpowers').available, true);
    assert.equal(r.json.tools.find((t) => t.id === 'bmad').available, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route --tool devflow 与 --force-devflow 等价', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n');
    detect(root, home);
    const r = run(root, home, ['--stage', 'plan', '--tool', 'devflow', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'use-devflow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route 拒绝非法阶段名', () => {
  const { root, home } = setup();
  try {
    const r = run(root, home, ['--stage', 'Plan!', '--json']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /非法阶段名/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('默认配置渲染后能被 YAML 解析器还原', () => {
  const config = defaultConfig();
  config.tools.superpowers.note = '第一行\n第二行';
  const parsed = parseYaml(renderConfig(config));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.routing.mode, 'ask');
  assert.deepEqual(Object.keys(parsed.tools).sort(), [
    'bmad', 'cc-spec-driven', 'openspec', 'spec-kit', 'spec-workflow', 'superpowers', 'ucai',
  ]);
  assert.equal(parsed.tools.superpowers.kind, 'technique');
  assert.equal(parsed.tools.bmad.kind, 'workflow');
  assert.equal(parsed.tools.superpowers.note, '第一行 第二行');
});

test('route 跳过 enabled:false 的工具检测', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, [
      'version: 1',
      'routing:',
      '  mode: auto',
      'tools:',
      '  superpowers:',
      '    enabled: false',
      '    kind: technique',
      '    stages: [plan]',
    ].join('\n') + '\n');
    const r = detect(root, home);
    assert.equal(r.json.available.includes('superpowers'), false);
    assert.equal(r.json.tools.superpowers.available, false);
    assert.deepEqual(r.json.tools.superpowers.signals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route --stage 在检测结果缺失时自动检测', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n');
    const stateFile = join(root, '.claude', '.ecosystem-state.json');
    assert.equal(existsSync(stateFile), false);
    const r = run(root, home, ['--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'delegate');
    assert.equal(r.json.tool.id, 'superpowers');
    assert.equal(existsSync(stateFile), true);
    assert.match(r.stderr, /自动检测/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route --detect 与 --stage 组合只输出一份决策 JSON', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n');
    const r = run(root, home, ['--detect', '--stage', 'plan', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.decision, 'delegate');
    assert.equal(r.json.tool.id, 'superpowers');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('route --detect 与 --list 组合只输出一份列表 JSON', () => {
  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    writeEco(root, 'version: 1\nrouting:\n  mode: auto\n');
    const r = run(root, home, ['--detect', '--list', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.mode, 'auto');
    assert.ok(Array.isArray(r.json.tools));
    assert.equal(r.json.tools.find((t) => t.id === 'superpowers').available, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('检测名拒绝路径穿越，只接受单段名称', () => {
  const config = defaultConfig();
  config.tools.superpowers.detectSkills = ['../../secret'];
  const { errors } = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('非法名称')), errors.join('\n'));

  const { root, home } = setup();
  try {
    addSkill(root, 'brainstorming');
    const mixed = defaultConfig();
    mixed.tools.superpowers.detectSkills = ['../skills/brainstorming', 'brainstorming'];
    const detected = detectTools(root, mixed, { home });
    assert.deepEqual(detected.superpowers.signals, ['skill:brainstorming']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
