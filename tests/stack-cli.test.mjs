import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contentHash } from '../scripts/lib/common.mjs';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function run(script, args, cwd, env = {}) {
  return spawnSync(NODE, [join(PLUGIN_ROOT, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // 隔离宿主机环境：缓存落在当前用例临时目录，禁用凭据交互与远程来源回退。
      DEVFLOW_CACHE_DIR: join(cwd, 'cache'),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      DEVFLOW_STACK_REPO: '',
      ...env,
    },
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

test('stack add --from 安装并写入 .stack-sources.json', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-cli-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), /plan/);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'].source, 'local');
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stack-lock.yaml')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack lint 校验仓库样例', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-lint-'));
  try {
    const repo = makeStackRepo(base);
    const res = run('hub-stack.mjs', ['lint', repo], base);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /java-spring/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('显式 --from 优先于 DEVFLOW_STACK_REPO 环境变量', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-env-from-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'],
      root,
      { DEVFLOW_STACK_REPO: 'https://example.com/stacks.git' },
    );
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), /plan/);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'].source, 'local');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack add --dry-run 不写目标目录、账本与 lock', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-dry-run-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--dry-run'], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
    assert.equal(existsSync(join(root, '.claude', '.stack-sources.json')), false);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stack-lock.yaml')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('非法 --as 被拒绝且不创建目标目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-bad-as-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const res = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--as', '../x', '--no-gen'],
      root,
    );
    assert.notEqual(res.status, 0, res.stdout);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'x')), false);
    assert.equal(res.stderr.includes('../x'), false, res.stderr);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--from 与 --ref / --offline 互斥', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-exclusive-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    const withRef = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--ref', 'v1', '--no-gen'],
      root,
    );
    const withOffline = run(
      'hub-stack.mjs',
      ['add', 'java-spring', '--root', root, '--from', repo, '--offline', '--no-gen'],
      root,
    );
    assert.notEqual(withRef.status, 0, withRef.stdout);
    assert.notEqual(withOffline.status, 0, withOffline.stdout);
    assert.match(withRef.stderr, /互斥/);
    assert.match(withOffline.stderr, /互斥/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function makeGitStackRepo(base) {
  const repo = join(base, 'git-stacks');
  mkdirSync(repo, { recursive: true });
  const g = (args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr + res.stdout);
  };
  g(['init', '-b', 'main']);
  g(['config', 'core.autocrlf', 'false']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'test']);
  const text = '# shared\n';
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
  g(['commit', '-m', 'init']);
  return repo;
}

test('stack add --repo 写入快照与 lock，list/status 可读', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-git-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', [
      'add', 'java-spring', '--root', root, '--repo', repo, '--ref', 'main', '--no-gen',
    ], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    const lock = readFileSync(join(root, '.claude', 'hub', 'stack-lock.yaml'), 'utf8');
    assert.match(lock, /commit:/);
    const ledger = JSON.parse(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'));
    assert.equal(ledger.packs['java-spring'].source, 'git');
    assert.match(ledger.packs['java-spring'].commit, /^[0-9a-f]{40}$/);

    const list = run('hub-stack.mjs', ['list', '--root', root], root, env);
    assert.match(list.stdout, /java-spring/);
    const status = run('hub-stack.mjs', ['status', '--root', root, '--json'], root, env);
    assert.equal(JSON.parse(status.stdout)[0].installedAs, 'java-spring');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stack lock 从本地账本重建可复现 lock', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-lock-'));
  try {
    const root = makeProject(base);
    const repo = makeStackRepo(base);
    run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--from', repo, '--no-gen'], root);
    const res = run('hub-stack.mjs', ['lock', '--root', root], root);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /跳过本地来源/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('cache gc 默认 dry-run，--apply 才删除过期快照', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-gc-'));
  try {
    const root = makeProject(base);
    const repo = makeGitStackRepo(base);
    const cache = join(base, 'cache');
    const env = { DEVFLOW_CACHE_DIR: cache, DEVFLOW_STACK_ALLOW_LOCAL_REPO: '1' };
    const add = run('hub-stack.mjs', ['add', 'java-spring', '--root', root, '--repo', repo, '--no-gen'], root, env);
    assert.equal(add.status, 0, add.stderr + add.stdout);
    // Task 8：快照位于 <cache>/<repo-id>/snapshots/<commit>/，逐仓库目录收集 meta。
    const metas = [];
    for (const repoDir of readdirSync(cache)) {
      const snapshots = join(cache, repoDir, 'snapshots');
      if (!existsSync(snapshots)) continue;
      for (const commit of readdirSync(snapshots)) {
        for (const name of readdirSync(join(snapshots, commit))) {
          if (name.endsWith('.meta.json')) metas.push(join(snapshots, commit, name));
        }
      }
    }
    assert.equal(metas.length, 1);
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(metas[0], old, old);
    const dry = run('hub-stack.mjs', ['cache', 'gc', '--root', root, '--keep-days', '1'], root, env);
    assert.match(dry.stdout, /将删除|dry-run/);
    assert.equal(existsSync(metas[0]), true);
    run('hub-stack.mjs', ['cache', 'gc', '--root', root, '--keep-days', '1', '--apply'], root, env);
    assert.equal(existsSync(metas[0]), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('init 生成 stack loader，CLI 注册 stack 子命令', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-stack-loader-'));
  try {
    const root = makeProject(base);
    assert.equal(existsSync(join(root, 'scripts', 'devflow-stack.mjs')), true);
    const help = spawnSync(NODE, [join(PLUGIN_ROOT, 'bin', 'devflow'), 'help'], { encoding: 'utf8' });
    assert.match(help.stdout, /stack/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
