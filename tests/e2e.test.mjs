import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
