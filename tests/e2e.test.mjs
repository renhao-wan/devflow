import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseYaml } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-e2e-'));
  mkdirSync(join(root, 'services', 'api'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sandbox', scripts: { test: 'node --test' } }));
  writeFileSync(join(root, 'services', 'api', 'package.json'), JSON.stringify({ name: 'api', scripts: { test: 'node --test' } }));
  return root;
}

test('init → gen → doctor → mark-test 全链路', () => {
  const root = makeSandbox();
  try {
    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(root, '.claude', 'hub', 'hub.yaml')));
    assert.ok(existsSync(join(root, '.claude', 'hub', 'stages', 'req', 'SKILL.md')));
    assert.ok(existsSync(join(root, '.claude', 'hub', 'stages', 'review', 'references', 'severity.md')));
    assert.ok(existsSync(join(root, '.claude', 'hub', 'stages', 'review', 'templates', 'review.template.md')));
    assert.ok(existsSync(join(root, '.claude', 'hub', 'stages', 'plan', 'references', 'prior-art-research.md')));
    assert.ok(existsSync(join(root, '.devflow.json')));
    for (const file of ['devflow-gen.mjs', 'devflow-doctor.mjs', 'devflow-route.mjs', 'devflow-upstream.mjs', 'devflow-test.mjs']) {
      assert.ok(existsSync(join(root, 'scripts', file)), `缺少 loader ${file}`);
    }
    assert.ok(existsSync(join(root, '.claude', 'hub', 'ecosystem.yaml')));
    assert.ok(existsSync(join(root, '.claude', '.ecosystem-state.json')));
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.ecosystem-state\.json/);

    const yaml = readFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'utf8');
    assert.match(yaml, /subprojects:/);
    assert.match(yaml, /services\/api|api:/);
    assert.match(yaml, /requiresPlugin:/);

    for (const stage of ['req', 'plan', 'implement', 'test', 'review', 'debug']) {
      assert.ok(existsSync(join(root, '.claude', 'skills', `devflow-${stage}`, 'SKILL.md')), `缺少投影 ${stage}`);
    }
    const manifest = JSON.parse(readFileSync(join(root, '.claude', '.hub-manifest.json'), 'utf8'));
    assert.equal(manifest.skills.length, 6);
    const reviewEntry = manifest.skills.find((s) => s.name === 'devflow-review');
    assert.deepEqual(reviewEntry.resources, ['references/severity.md', 'templates/review.template.md']);
    const planEntry = manifest.skills.find((s) => s.name === 'devflow-plan');
    assert.ok(planEntry.resources.includes('references/prior-art-research.md'));

    const reviewProjection = readFileSync(join(root, '.claude', 'skills', 'devflow-review', 'SKILL.md'), 'utf8');
    assert.match(reviewProjection, /## 阶段资源/);
    assert.match(reviewProjection, /references\/severity\.md/);
    assert.match(reviewProjection, /templates\/review\.template\.md/);

    const gen = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /0 个错误/);

    const home = join(root, 'empty-home');
    mkdirSync(home, { recursive: true });
    const detect = run('hub-route.mjs', ['--root', root, '--detect', '--home', home], root);
    assert.equal(detect.status, 0, detect.stderr);
    const route = run('hub-route.mjs', ['--root', root, '--home', home, '--stage', 'plan', '--json'], root);
    assert.equal(route.status, 0, route.stderr);
    assert.ok(['use-devflow', 'suggest', 'delegate'].includes(JSON.parse(route.stdout).decision));

    const mark = run('mark-test.mjs', ['--root', root, '--command', 'npm test'], root);
    assert.equal(mark.status, 0, mark.stderr);
    const state = JSON.parse(readFileSync(join(root, '.claude', '.devflow-state.json'), 'utf8'));
    assert.equal(state.lastTestCommand, 'npm test');
    assert.ok(state.lastTestPassedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('手改投影后 --check 与 doctor 能发现漂移', () => {
  const root = makeSandbox();
  try {
    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stderr);

    const target = join(root, '.claude', 'skills', 'devflow-req', 'SKILL.md');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n手改\n`);

    const check = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /漂移/);

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.match(doctor.stdout, /投影被手改或过期/);

    const regen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(regen.status, 0, regen.stderr);
    const after = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(after.status, 0, after.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('子项目测试命令可从根执行，并识别包管理器', () => {
  const root = makeSandbox();
  try {
    mkdirSync(join(root, 'services', 'worker'), { recursive: true });
    writeFileSync(join(root, 'services', 'worker', 'package.json'), JSON.stringify({
      name: 'worker',
      scripts: { build: 'tsc' },
    }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');

    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stderr);
    const config = parseYaml(readFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'utf8'));

    // 子项目命令从根执行；包管理器沿用根目录的 lockfile。
    assert.equal(config.subprojects.api.testCommand, 'cd services/api && pnpm run test');
    assert.equal(config.subprojects.worker.testCommand, undefined);
    assert.equal(config.defaults.testCommand, 'pnpm run test');
    assert.deepEqual(Object.keys(config.subprojects), ['api', 'worker']);
    assert.match(init.stdout, /services\/worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gen 跳过不受管理的同名投影，不接管也不覆盖', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const manifestFile = join(root, '.claude', '.hub-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.skills = manifest.skills.filter((s) => s.name !== 'devflow-req');
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const target = join(root, '.claude', 'skills', 'devflow-req', 'SKILL.md');
    writeFileSync(target, '手写内容\n');

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 1, gen.stderr + gen.stdout);
    assert.match(gen.stdout + gen.stderr, /不受 devflow 管理/);
    assert.equal(readFileSync(target, 'utf8'), '手写内容\n');
    const after = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(after.skills.some((s) => s.name === 'devflow-req'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('源文件缺失时保留旧投影与账本条目', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const source = join(root, '.claude', 'hub', 'stages', 'test', 'SKILL.md');
    const projection = join(root, '.claude', 'skills', 'devflow-test', 'SKILL.md');
    const before = readFileSync(projection, 'utf8');
    rmSync(source);

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 1);
    assert.match(gen.stdout + gen.stderr, /缺少源文件/);
    assert.equal(existsSync(projection), true);
    assert.equal(readFileSync(projection, 'utf8'), before);
    const manifest = JSON.parse(readFileSync(join(root, '.claude', '.hub-manifest.json'), 'utf8'));
    assert.ok(manifest.skills.some((s) => s.name === 'devflow-test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gen --json 普通执行时 stdout 只输出可解析的 JSON', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const gen = run('gen-claude-skills.mjs', ['--root', root, '--json'], root);
    assert.equal(gen.status, 0, gen.stderr);
    const report = JSON.parse(gen.stdout);
    assert.equal(report.written.length, 6);
    assert.equal(report.errors.length, 0);
    assert.doesNotMatch(gen.stdout, /\[OK\]/);
    assert.match(gen.stderr, /\[ok\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gen 清理账本中已移除的过期投影', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);

    const staleDir = join(root, '.claude', 'skills', 'devflow-old');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'SKILL.md'), 'old');
    const manifestFile = join(root, '.claude', '.hub-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.skills.push({
      name: 'devflow-old',
      target: '.claude/skills/devflow-old/SKILL.md',
      source: '.claude/hub/stages/old/SKILL.md',
      hash: 'stale',
    });
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    const check = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /已过期/);

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 0, gen.stderr);
    assert.equal(existsSync(staleDir), false);
    const after = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(after.skills.some((s) => s.name === 'devflow-old'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('新增阶段资源触发投影漂移并可重新生成', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const refDir = join(root, '.claude', 'hub', 'stages', 'test', 'references');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'custom.md'), '# 项目自定义检查\n');

    const check = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /devflow-test/);

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 0, gen.stderr);
    const projection = readFileSync(join(root, '.claude', 'skills', 'devflow-test', 'SKILL.md'), 'utf8');
    assert.match(projection, /references\/custom\.md/);

    const after = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(after.status, 0, after.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor 提示阶段资源缺失', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    rmSync(join(root, '.claude', 'hub', 'stages', 'review', 'references'), { recursive: true, force: true });

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.match(doctor.stdout, /阶段资源缺失/);
    assert.match(doctor.stdout, /references\/severity\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('版本不满足时生成器拒绝', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const hub = join(root, '.claude', 'hub', 'hub.yaml');
    writeFileSync(hub, readFileSync(hub, 'utf8').replace(/requiresPlugin: .*/, 'requiresPlugin: "^99.0.0"'));
    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 1);
    assert.match(gen.stderr, /不满足/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init 写入的 .gitignore 忽略 loader 且重复运行不会叠加片段', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /scripts\/devflow-gen\.mjs/);
    assert.match(gitignore, /scripts\/devflow-doctor\.mjs/);
    assert.match(gitignore, /scripts\/devflow-upstream\.mjs/);
    assert.match(gitignore, /scripts\/devflow-test\.mjs/);

    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    assert.equal(run('hub-init.mjs', ['--root', root, '--force'], root).status, 0);
    const again = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.equal((again.match(/# >>> devflow/g) || []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('生成器拒绝越界阶段名，不写到 .claude/skills 之外', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const hub = join(root, '.claude', 'hub', 'hub.yaml');
    writeFileSync(hub, readFileSync(hub, 'utf8').replace('  - req', '  - ../evil'));
    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 1);
    assert.match(gen.stdout + gen.stderr, /阶段名.*非法/);
    assert.equal(existsSync(join(root, '.claude', 'evil')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor 检查 cd 目标、本地 gradlew、gitignore 与 loader', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);

    rmSync(join(root, 'services', 'api'), { recursive: true, force: true });
    writeFileSync(join(root, 'gradlew.bat'), '@echo off\n');
    rmSync(join(root, '.gitignore'));
    rmSync(join(root, 'scripts'), { recursive: true, force: true });

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.match(doctor.stdout, /cd 目录不存在/);
    assert.match(doctor.stdout, /缺少 \.gitignore/);
    assert.match(doctor.stdout, /缺少 loader/);

    // gradlew.bat 存在时不应报告本地命令缺失
    assert.doesNotMatch(doctor.stdout, /本地命令不存在：gradlew\.bat/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mark-test 清除 testsPending 标记', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    writeFileSync(join(root, '.claude', '.devflow-state.json'), JSON.stringify({
      changedFiles: ['src/a.js'],
      lastChangeAt: '2026-01-01T00:00:00.000Z',
      testsPending: true,
    }));
    assert.equal(run('mark-test.mjs', ['--root', root, '--command', 'npm test'], root).status, 0);
    const state = JSON.parse(readFileSync(join(root, '.claude', '.devflow-state.json'), 'utf8'));
    assert.equal(state.testsPending, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init 展开 Maven 多模块并生成模块级测试命令', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-maven-'));
  try {
    mkdirSync(join(root, 'service', 'core'), { recursive: true });
    mkdirSync(join(root, 'service', 'web'), { recursive: true });
    writeFileSync(join(root, 'service', 'pom.xml'), [
      '<project>',
      '  <modules>',
      '    <module>core</module>',
      '    <module>web</module>',
      '  </modules>',
      '</project>',
    ].join('\n'));
    writeFileSync(join(root, 'service', 'core', 'pom.xml'), '<project><artifactId>core</artifactId></project>');
    writeFileSync(join(root, 'service', 'web', 'pom.xml'), '<project><artifactId>web</artifactId></project>');

    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.match(init.stdout, /Maven 多模块已展开/);

    const config = parseYaml(readFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'utf8'));
    assert.deepEqual(Object.keys(config.subprojects).sort(), ['core', 'web']);
    assert.equal(config.subprojects.core.path, 'service/core');
    assert.equal(config.subprojects.core.testCommand, 'cd service/core && mvn test');
    assert.equal(config.subprojects.web.testCommand, 'cd service/web && mvn test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init 忽略指向工作区外的 Maven 模块', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-maven-escape-'));
  const escapedName = `escaped-${basename(root)}`;
  const escaped = resolve(root, '..', escapedName);
  try {
    mkdirSync(join(root, 'service'), { recursive: true });
    writeFileSync(join(root, 'service', 'pom.xml'), [
      '<project>',
      '  <modules>',
      `    <module>../../${escapedName}</module>`,
      '  </modules>',
      '</project>',
    ].join('\n'));
    mkdirSync(escaped, { recursive: true });
    writeFileSync(join(escaped, 'pom.xml'), '<project><artifactId>escaped</artifactId></project>');

    const init = run('hub-init.mjs', ['--root', root], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);

    const yaml = readFileSync(join(root, '.claude', 'hub', 'hub.yaml'), 'utf8');
    assert.doesNotMatch(yaml, new RegExp(escapedName));
    assert.doesNotMatch(yaml, /\.\.\//);
    const config = parseYaml(yaml);
    assert.deepEqual(Object.keys(config.subprojects), ['service']);
  } finally {
    rmSync(escaped, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor 提示 testCommand 依赖的工具不在 PATH', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const hub = join(root, '.claude', 'hub', 'hub.yaml');
    writeFileSync(hub, readFileSync(hub, 'utf8').replace(/testCommand: .*/, 'testCommand: "mvn test"'));

    const emptyBin = mkdtempSync(join(tmpdir(), 'devflow-empty-path-'));
    try {
      const r = spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', 'hub-doctor.mjs'), '--root', root], {
        encoding: 'utf8',
        env: { ...process.env, PATH: emptyBin },
      });
      assert.match(r.stdout, /测试命令依赖 mvn，PATH 中找不到/);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('_shared 规则注入所有投影，变更后 doctor 提示重新生成', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const sharedDir = join(root, '.claude', 'hub', '_shared');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'security.md'), '# 安全\n\n- 不提交密钥。\n');

    const gen = run('gen-claude-skills.mjs', ['--root', root], root);
    assert.equal(gen.status, 0, gen.stderr);
    for (const stage of ['req', 'plan', 'implement', 'test', 'review', 'debug']) {
      const projection = readFileSync(join(root, '.claude', 'skills', `devflow-${stage}`, 'SKILL.md'), 'utf8');
      assert.match(projection, /## 共享规则/);
      assert.match(projection, /不提交密钥/);
    }
    const manifest = JSON.parse(readFileSync(join(root, '.claude', '.hub-manifest.json'), 'utf8'));
    assert.equal(manifest.shared.length, 1);
    assert.equal(manifest.shared[0].path, '.claude/hub/_shared/security.md');

    const check = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(check.status, 0, check.stdout);

    writeFileSync(join(sharedDir, 'security.md'), '# 安全\n\n- 不提交密钥。\n- 不记录个人路径。\n');
    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.match(doctor.stdout, /共享规则已变更/);

    assert.equal(run('gen-claude-skills.mjs', ['--root', root], root).status, 0);
    assert.match(readFileSync(join(root, '.claude', 'skills', 'devflow-req', 'SKILL.md'), 'utf8'), /不记录个人路径/);
    assert.doesNotMatch(run('hub-doctor.mjs', ['--root', root], root).stdout, /共享规则已变更/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init 自动刷新旧 loader，doctor 能发现过期 loader', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const loader = join(root, 'scripts', 'devflow-gen.mjs');
    writeFileSync(loader, '#!/usr/bin/env node\n// 旧 loader\n');
    assert.match(run('hub-doctor.mjs', ['--root', root], root).stdout, /loader 内容过期/);

    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const refreshed = readFileSync(loader, 'utf8');
    assert.match(refreshed, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(run('hub-doctor.mjs', ['--root', root], root).stdout, /loader 内容过期/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor 结合 testsPending 与改动时间判断测试状态', () => {
  const root = makeSandbox();
  try {
    assert.equal(run('hub-init.mjs', ['--root', root], root).status, 0);
    const stateFile = join(root, '.claude', '.devflow-state.json');
    writeFileSync(stateFile, JSON.stringify({
      lastChangeAt: '2026-01-02T00:00:00.000Z',
      lastTestPassedAt: '2026-01-01T00:00:00.000Z',
      testsPending: false,
    }));
    assert.match(run('hub-doctor.mjs', ['--root', root], root).stdout, /改动晚于测试通过时间/);

    writeFileSync(stateFile, JSON.stringify({
      lastChangeAt: '2026-01-02T00:00:00.000Z',
      lastTestPassedAt: '2026-01-03T00:00:00.000Z',
      testsPending: false,
    }));
    assert.match(run('hub-doctor.mjs', ['--root', root], root).stdout, /最近一次测试通过/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
