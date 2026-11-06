import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRemoteShipArgs } from '../scripts/hub-upstream.mjs';
import { contentHash } from '../scripts/lib/common.mjs';
import { detectFrameworks } from '../scripts/lib/discover.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const PLUGIN_VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const NODE = process.execPath;

function run(script, args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function makeProject(base) {
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
  const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
  assert.equal(init.status, 0, init.stderr + init.stdout);
  return root;
}

function makeStackRepo(base) {
  const repo = join(base, 'stacks-repo');
  const files = { '_shared.md': '# shared\n', 'plan.md': '# plan\n' };
  const hashes = {};
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, 'stacks', 'java-spring', ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
    hashes[rel] = contentHash(text);
  }
  writeFileSync(join(repo, 'stacks', 'java-spring', 'stack.json'), JSON.stringify({
    name: 'java-spring', title: 'Spring', version: '1.2.0', minDevflow: '>=1.7.0',
    detects: ['java-maven'], files: hashes,
  }, null, 2));
  writeFileSync(join(repo, 'index.json'), JSON.stringify({
    schemaVersion: 1,
    packs: { 'java-spring': { title: 'Spring', path: 'stacks/java-spring', detects: ['java-maven'] } },
  }, null, 2));
  return repo;
}

function writeLedger(root, packs) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({ schemaVersion: 1, packs }));
}

function stackRecord(overrides = {}) {
  return {
    installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
    path: 'stacks/java-spring', version: '1.0.0', files: {},
    ...overrides,
  };
}

test('sync 跳过受管栈路径，不用模板库覆盖 pack', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# pack content\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0', files: {},
        },
      },
    }));
    // 受管路径下的旧记录不能被误报为“模板已移除”。
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: {
        '.claude/hub/stacks/java-spring/old.md': { base: 'x', local: 'x', source: 'upstream' },
      },
    }));
    // 使用独立 plugin fixture，避免修改仓库模板。
    // 版本必须满足 makeProject 写出的 requiresPlugin（^<当前版本>），否则 sync 会在版本门禁处失败。
    const fixture = join(base, 'plugin');
    mkdirSync(join(fixture, '.claude-plugin'), { recursive: true });
    writeFileSync(join(fixture, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'devflow', version: PLUGIN_VERSION }));
    mkdirSync(join(fixture, 'templates', 'stages', 'req'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stages', 'req', 'SKILL.md'), '---\nname: req\ndescription: req\n---\n\nreq\n');
    mkdirSync(join(fixture, 'templates', 'stacks', 'java-spring'), { recursive: true });
    writeFileSync(join(fixture, 'templates', 'stacks', 'java-spring', '_shared.md'), '# template content\n');

    // --force：若未跳过受管路径，会直接覆盖 pack，确保测试能抓住回归。
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', fixture, '--no-gen', '--force'], root);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
    assert.match(readFileSync(join(dir, '_shared.md'), 'utf8'), /pack content/);
    assert.match(sync.stdout, /受管栈 java-spring/);
    assert.doesNotMatch(sync.stdout, /stacks\/java-spring\/_shared\.md/);
    assert.doesNotMatch(sync.stdout, /模板已移除/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('upstream --all 与 ship --all 排除受管栈，显式 --stack 拒绝', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-upstream-'));
  try {
    const root = makeProject(base);
    // makeProject 用 --no-draft 初始化，_shared 目录为空；补一个文件让 --all 能走到技术栈检查。
    writeFileSync(join(root, '.claude', 'hub', '_shared', 'project-basics.md'), '# 共享规则\n');
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# pack content\n');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0', files: {},
        },
      },
    }));
    const all = run('hub-upstream.mjs', ['--root', root, '--all'], root);
    assert.equal(all.status, 0, all.stderr + all.stdout);
    assert.doesNotMatch(all.stdout, /java-spring 技术栈/);
    assert.match(all.stdout, /受管栈 java-spring/);

    const explicit = run('hub-upstream.mjs', ['--root', root, '--stack', 'java-spring'], root);
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /stack pack 管理/);

    const allowed = run('hub-upstream.mjs', ['--root', root, '--stack', 'java-spring', '--allow-fork'], root);
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    // 放行后必须真正进入计划，而不是被静默跳过。
    assert.match(allowed.stdout, /java-spring 技术栈/);
    assert.doesNotMatch(allowed.stdout, /受管栈 java-spring/);

    const shipExplicit = run('hub-ship.mjs', ['--root', root, '--stack', 'java-spring'], root);
    assert.notEqual(shipExplicit.status, 0);
    assert.match(shipExplicit.stderr, /stack pack 管理/);

    // ship 侧的放行检查只断言不再命中受管错误；其余环境错误不在本测试范围。
    const shipAllowed = run('hub-ship.mjs', ['--root', root, '--stack', 'java-spring', '--allow-fork', '--dry-run'], root);
    assert.doesNotMatch(shipAllowed.stderr, /stack pack 管理/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('upstream --pr 委托 ship 时透传 --allow-fork', () => {
  const opts = {
    root: '/project',
    pluginRoot: '/plugin',
    units: [{ kind: 'stack', name: 'java-spring' }],
    target: { kind: 'upstream', pr: true },
  };
  const withFork = buildRemoteShipArgs(['--allow-fork', '--apply'], opts);
  assert.ok(withFork.includes('--allow-fork'), withFork.join(' '));
  assert.ok(withFork.includes('--stack'));
  assert.equal(withFork.includes('--dry-run'), false);
  const without = buildRemoteShipArgs(['--apply'], opts);
  assert.equal(without.includes('--allow-fork'), false);
});

test('账本损坏时 sync fail closed', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-sync-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const sync = run('hub-sync.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-gen'], root);
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 报告受管栈缺失文件与陈旧 hub-sources 记录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/x', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0',
          files: {
            '.claude/hub/stacks/java-spring/_shared.md': { base: 'x', local: 'x' },
            '.claude/hub/stacks/java-spring/plan.md': { base: 'y', local: 'y' },
          },
        },
      },
    }));
    writeFileSync(join(dir, '_shared.md'), '# local edit\n');
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: { '.claude/hub/stacks/java-spring/_shared.md': { base: 'z', local: 'z' } },
    }));
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /plan\.md.*缺失|缺失.*plan\.md/);
    assert.match(res.stdout, /陈旧/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在账本损坏时报错', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-bad-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), '{ broken');
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /安装账本损坏/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在没有受管栈时保持正常', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-empty-'));
  try {
    const root = makeProject(base);
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /没有受管的技术栈包/);
    assert.doesNotMatch(res.stdout, /未安装的包/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在账本为空时仍报告 stack-lock.yaml 的孤立条目', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-ghost-'));
  try {
    const root = makeProject(base);
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {},
    }));
    writeFileSync(join(root, '.claude', 'hub', 'stack-lock.yaml'), [
      'version: 1',
      'packs:',
      '  ghost:',
      '    installedAs: ghost',
      "    repo: 'https://example.com/packs.git'",
      '    packId: ghost',
      '    path: stacks/ghost',
      '    ref: main',
      `    commit: ${'a'.repeat(40)}`,
      "    version: '1.0.0'",
      '',
    ].join('\n'));
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /stack-lock\.yaml 记录了未安装的包 ghost/);
    assert.doesNotMatch(res.stdout, /没有受管的技术栈包/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor --check-remote 报告落后 commit，默认不联网', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-remote-'));
  try {
    const root = makeProject(base);
    const repo = join(base, 'remote');
    mkdirSync(repo, { recursive: true });
    const g = (args) => {
      const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr + res.stdout);
    };
    g(['init', '-b', 'main']);
    g(['config', 'user.email', 'test@example.com']);
    g(['config', 'user.name', 'test']);
    const writePack = (text) => {
      const packDir = join(repo, 'stacks', 'java-spring');
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, '_shared.md'), text);
      writeFileSync(join(packDir, 'stack.json'), JSON.stringify({
        name: 'java-spring', version: '1.2.0', minDevflow: '>=1.7.0',
        detects: ['java-maven'], files: { '_shared.md': contentHash(text) },
      }));
      writeFileSync(join(repo, 'index.json'), JSON.stringify({
        schemaVersion: 1,
        packs: { 'java-spring': { path: 'stacks/java-spring', detects: ['java-maven'] } },
      }));
      g(['add', '.']);
      g(['commit', '-m', 'pack']);
    };
    writePack('# shared v1\n');
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', [
      'add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen',
    ], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);

    // 默认 doctor 不碰网络：给一个全新缓存目录，运行后应仍不存在。
    const quietCache = join(base, 'quiet-cache');
    const quiet = run('hub-doctor.mjs', ['--root', root], root, {
      DEVFLOW_CACHE_DIR: quietCache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1',
    });
    assert.equal(quiet.status, 0, quiet.stderr + quiet.stdout);
    assert.doesNotMatch(quiet.stdout, /落后/);
    assert.equal(existsSync(quietCache), false);

    writePack('# shared v2\n');
    const checked = run('hub-doctor.mjs', ['--root', root, '--check-remote'], root, env);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.match(checked.stdout, /落后/);
    assert.match(checked.stdout, /stack update/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 不对本地来源提示未写入 stack-lock.yaml', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-local-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    // 设计第 3 节：本地来源本来就不写 lock，永久告警只会误导用户。
    assert.doesNotMatch(res.stdout, /未写入 stack-lock\.yaml/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 对 git 来源缺失 lock 条目给出提醒', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-git-lock-'));
  try {
    const root = makeProject(base);
    mkdirSync(join(root, '.claude', 'hub', 'stacks', 'java-spring'), { recursive: true });
    writeLedger(root, {
      'java-spring': stackRecord({
        source: 'git',
        repo: 'https://example.com/packs.git',
        ref: 'main',
        commit: 'a'.repeat(40),
      }),
    });
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /受管栈 java-spring 未写入 stack-lock\.yaml/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 将 local 为 null 的文件按缺失报告而不是手改', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-null-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# present\n');
    writeLedger(root, {
      'java-spring': stackRecord({
        files: { '.claude/hub/stacks/java-spring/_shared.md': { base: 'x', local: null } },
      }),
    });
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /缺失 1 个文件/);
    assert.doesNotMatch(res.stdout, /被手改/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 提示受管文件被手改但保持退出码 0', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-modified-'));
  try {
    const root = makeProject(base);
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# edited\n');
    writeLedger(root, {
      'java-spring': stackRecord({
        files: {
          '.claude/hub/stacks/java-spring/_shared.md': {
            base: contentHash('# original\n'),
            local: contentHash('# original\n'),
          },
        },
      }),
    });
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /1 个文件被手改/);
    assert.doesNotMatch(res.stdout, /缺失/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 报告 base 偏离（即使本地内容与 local 哈希一致）', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-base-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const rel = '.claude/hub/stacks/java-spring/plan.md';
    const ledgerFile = join(root, '.claude', '.stack-sources.json');
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    ledger.packs['java-spring'].files[rel].base = contentHash('# other base\n');
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));

    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /1 个文件被手改/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 报告受管栈的额外文件且不回显账本 key', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-extra-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const stackDir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    writeFileSync(join(stackDir, 'extra.md'), '# extra\n');

    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /额外文件/);
    assert.match(res.stdout, /extra\.md/);
    // 额外文件存在时不能再报“完整”。
    assert.doesNotMatch(res.stdout, /受管栈 java-spring@.*完整/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在受管目录缺失时报错并退出 1', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-missing-dir-'));
  try {
    const root = makeProject(base);
    writeLedger(root, { 'java-spring': stackRecord() });
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /受管栈目录缺失/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 在受管目录缺失时仍检查陈旧 .hub-bases 快照', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-missing-dir-bases-'));
  try {
    const root = makeProject(base);
    mkdirSync(join(root, '.claude', '.hub-bases', 'stacks', 'java-spring'), { recursive: true });
    writeLedger(root, { 'java-spring': stackRecord() });
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /受管栈目录缺失/);
    assert.match(res.stdout, /陈旧的 \.hub-bases 快照/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init 写入 stack 忽略项并提示 Java 包', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-init-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pom.xml'), '<project></project>');
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const line of ['.claude/.stack-sources.json', '.claude/.stack-bases/', '.claude/.stack-staging/', '.claude/.stack-trash/']) {
      assert.match(ignore, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(init.stdout, /devflow stack add java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('Vue 3 项目提示 vue3 包', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-vue-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'web', dependencies: { vue: '^3.5.0' }, scripts: { test: 'node --test' },
    }));
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.match(init.stdout, /devflow stack add vue3/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor 拒绝越界的账本文件路径且不回显 key', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-doctor-escape-'));
  try {
    const root = makeProject(base);
    mkdirSync(join(root, '.claude', 'hub', 'stacks', 'java-spring'), { recursive: true });
    writeLedger(root, {
      'java-spring': stackRecord({
        files: { '../../outside.txt': { base: 'x', local: 'x' } },
      }),
    });
    const res = run('hub-doctor.mjs', ['--root', root], root);
    assert.equal(res.status, 1, res.stderr + res.stdout);
    // 设计第 13 节：不可信 key 不得回显到输出。
    assert.doesNotMatch(`${res.stdout}${res.stderr}`, /outside\.txt/);
    assert.match(res.stdout, /非法文件路径/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('detectFrameworks 按主版本识别 Vue 3', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-vue-detect-'));
  try {
    const dir = join(base, 'app');
    mkdirSync(dir, { recursive: true });
    const writeVue = (vue) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { vue } }));
    for (const vue of ['^3', '3', '^3.5.0', '~3.4', '>=3.0', '3.x', 'npm:vue@3.5.0']) {
      writeVue(vue);
      assert.deepEqual(detectFrameworks(dir), ['vue3'], `应识别 ${vue}`);
    }
    for (const vue of ['^2.7.0', '>=2.6.0 <3.0.0', '10.3.x']) {
      writeVue(vue);
      assert.deepEqual(detectFrameworks(dir), [], `应拒绝 ${vue}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init 提示不回显带凭据的 stack 仓库地址', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-cred-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pom.xml'), '<project></project>');
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root, {
      DEVFLOW_STACK_REPO: 'https://user:secret@example.com/repo.git',
    });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.doesNotMatch(`${init.stdout}${init.stderr}`, /secret/);
    assert.match(init.stdout, /--repo <仓库地址>/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init 提示展示安全的 stack 仓库地址', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-repo-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pom.xml'), '<project></project>');
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root, {
      DEVFLOW_STACK_REPO: 'https://github.com/acme/stacks.git',
    });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.ok(init.stdout.includes('--repo https://github.com/acme/stacks.git'), init.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init 在旧标记块中补齐 stack 忽略项', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-old-ignore-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), [
      '# >>> devflow (generated, do not commit)',
      '.claude/.hub-sources.json',
      '.claude/.hub-bases/',
      '# <<< devflow',
      '',
    ].join('\n'));
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
    for (const line of ['.claude/.stack-sources.json', '.claude/.stack-bases/', '.claude/.stack-staging/', '.claude/.stack-trash/']) {
      assert.match(ignore, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(ignore.match(/# >>> devflow/g).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('非 Java 非 Vue 项目不提示安装技术栈', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-plain-'));
  try {
    const root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'plain', scripts: { test: 'node --test' } }));
    const init = run('hub-init.mjs', ['--root', root, '--plugin-root', PLUGIN_ROOT, '--no-draft'], root);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.doesNotMatch(init.stdout, /devflow stack add/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
