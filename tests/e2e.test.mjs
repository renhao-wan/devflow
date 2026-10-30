import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    assert.ok(existsSync(join(root, '.devflow.json')));
    for (const file of ['devflow-gen.mjs', 'devflow-doctor.mjs', 'devflow-upstream.mjs', 'devflow-test.mjs']) {
      assert.ok(existsSync(join(root, 'scripts', file)), `缺少 loader ${file}`);
    }

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

    const reviewProjection = readFileSync(join(root, '.claude', 'skills', 'devflow-review', 'SKILL.md'), 'utf8');
    assert.match(reviewProjection, /## 阶段资源/);
    assert.match(reviewProjection, /references\/severity\.md/);
    assert.match(reviewProjection, /templates\/review\.template\.md/);

    const gen = run('gen-claude-skills.mjs', ['--root', root, '--check'], root);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);

    const doctor = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.match(doctor.stdout, /0 个错误/);

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
