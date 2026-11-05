import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  ensureRepo, resolveCommit, fetchCommit, refreshRef, gitRun, stackCacheRoot,
  materializeSnapshot, verifySnapshot,
} from '../scripts/lib/stack-fetch.mjs';
import { contentHash } from '../scripts/lib/common.mjs';

// 离线测试环境：不读系统/用户 git 配置，也不允许终端或凭据管理器弹出交互。
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'devflow-fetch-config-'));
const EMPTY_CONFIG = join(CONFIG_DIR, 'gitconfig');
writeFileSync(EMPTY_CONFIG, '');
process.on('exit', () => {
  try {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结果。
  }
});

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
};

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  return res.stdout.trim();
}

export function makeGitRepo(base, files) {
  const repo = join(base, 'remote');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

/** 每个用例把默认缓存根指向自己的临时目录，避免误用真实用户目录。 */
function withCacheEnv(base, fn) {
  const prev = process.env.DEVFLOW_CACHE_DIR;
  process.env.DEVFLOW_CACHE_DIR = join(base, 'cache');
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DEVFLOW_CACHE_DIR;
    else process.env.DEVFLOW_CACHE_DIR = prev;
  }
}

function addCommit(repo, text) {
  writeFileSync(join(repo, 'index.json'), text);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'update']);
  return git(repo, ['rev-parse', 'HEAD']);
}

test('裸缓存可重复创建并解析 ref', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const cacheRoot = join(base, 'cache');
      const first = ensureRepo({ url: remote, cacheRoot, allowFile: true });
      const second = ensureRepo({ url: remote, cacheRoot, allowFile: true });
      assert.equal(first.repoGit, second.repoGit);
      assert.equal(existsSync(first.repoGit), true);
      const commit = resolveCommit({ repoGit: first.repoGit, ref: 'main' });
      assert.match(commit, /^[0-9a-f]{40}$/);
      fetchCommit({ repoGit: first.repoGit, commit, ref: 'main' });
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('离线且缓存不存在时明确失败', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-offline-'));
  try {
    withCacheEnv(base, () => {
      assert.throws(
        () => ensureRepo({ url: 'https://example.com/r.git', cacheRoot: join(base, 'cache'), offline: true }),
        /离线/,
      );
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refreshRef 把 ref 更新到远程最新 commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-refresh-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const cacheRoot = join(base, 'cache');
      const { repoGit } = ensureRepo({ url: remote, cacheRoot, allowFile: true });
      const stale = resolveCommit({ repoGit, ref: 'main' });
      assert.equal(stale, git(remote, ['rev-parse', 'HEAD']));

      const latest = addCommit(remote, '{"packs":{}}');
      assert.notEqual(latest, stale);

      refreshRef({ repoGit, ref: 'main' });
      assert.equal(resolveCommit({ repoGit, ref: 'main' }), latest);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fetchCommit 离线且对象缺失时明确失败', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-offline-commit-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
      assert.throws(
        () => fetchCommit({ repoGit, commit: 'f'.repeat(40), offline: true }),
        /离线/,
      );
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('以 - 开头的 ref/commit 被拒绝且不回显输入', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-inject-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
      const hostile = '--upload-pack=x';
      const rejected = (fn) => assert.throws(fn, (err) => {
        assert.match(err.message, /非法/);
        assert.equal(err.message.includes(hostile), false);
        return true;
      });
      rejected(() => refreshRef({ repoGit, ref: hostile }));
      rejected(() => fetchCommit({ repoGit, commit: hostile }));
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('tag 刷新后解析到远程最新 commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-tag-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      git(remote, ['tag', 'v1']);
      const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
      const stale = resolveCommit({ repoGit, ref: 'v1' });

      const latest = addCommit(remote, '{"packs":{}}');
      git(remote, ['tag', '-f', 'v1']);
      assert.notEqual(latest, stale);

      refreshRef({ repoGit, ref: 'v1' });
      assert.equal(resolveCommit({ repoGit, ref: 'v1' }), latest);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('刷新不存在的 ref 会失败', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-missing-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
      assert.throws(() => refreshRef({ repoGit, ref: 'no-such-ref' }), /无法刷新/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('filter clone 失败时回退普通 clone 且不残留临时目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-fallback-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      let filteredFailures = 0;
      const run = (args, opts) => {
        if (args.includes('--filter=blob:none')) {
          filteredFailures += 1;
          throw new Error('filter unsupported');
        }
        return gitRun(args, opts);
      };
      const { repoGit } = ensureRepo({
        url: remote, cacheRoot: join(base, 'cache'), allowFile: true, run,
      });
      assert.equal(filteredFailures, 1);
      assert.equal(existsSync(join(repoGit, 'HEAD')), true);
      const leftovers = readdirSync(dirname(repoGit))
        .filter((name) => name.startsWith('repo.git.tmp-'));
      assert.deepEqual(leftovers, []);
      assert.match(resolveCommit({ repoGit, ref: 'main' }), /^[0-9a-f]{40}$/);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('缓存缺少 HEAD 时按损坏处理', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-corrupt-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const cacheRoot = join(base, 'cache');
      const { repoGit } = ensureRepo({ url: remote, cacheRoot, allowFile: true });
      rmSync(join(repoGit, 'HEAD'));
      assert.throws(
        () => ensureRepo({ url: remote, cacheRoot, allowFile: true }),
        (err) => err.code === 'STACK_CACHE' && /删除该缓存目录/.test(err.message),
      );
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('clone 后远程新建的分支可通过 fetchCommit 建立并解析', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-newbranch-'));
  try {
    withCacheEnv(base, () => {
      const remote = makeGitRepo(base, { 'index.json': '{}' });
      const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });

      git(remote, ['checkout', '-q', '-b', 'side']);
      const latest = addCommit(remote, '{"packs":{"side":{}}}');
      git(remote, ['checkout', '-q', 'main']);

      fetchCommit({ repoGit, ref: 'side' });
      assert.equal(resolveCommit({ repoGit, ref: 'side' }), latest);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('stackCacheRoot 解析显式目录并保留默认目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-root-'));
  try {
    assert.equal(
      stackCacheRoot({ DEVFLOW_CACHE_DIR: join(base, 'cache') }),
      resolve(join(base, 'cache')),
    );
    assert.equal(
      stackCacheRoot({}),
      resolve(join(homedir(), '.devflow', 'cache', 'stacks')),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('gitRun 每次调用都读取当前环境', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-gitenv-'));
  const prev = process.env.GIT_CONFIG_GLOBAL;
  try {
    const config = join(base, 'gitconfig');
    writeFileSync(config, '[init]\n\tdefaultBranch = envbranch\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    const repo = join(base, 'repo');
    gitRun(['init', '-q', repo]);
    assert.equal(gitRun(['-C', repo, 'symbolic-ref', '--short', 'HEAD']).trim(), 'envbranch');
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test('按 commit 物化单个包目录并复用快照', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-'));
  try {
    const remote = makeGitRepo(base, {
      'index.json': '{}',
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', minDevflow: '>=1.7.0',
        detects: ['java-maven'],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
      'stacks/vue3/_shared.md': '# vue\n',
    });
    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    const first = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'), loaderFiles: new Set(), pluginVersion: '1.7.0',
    });
    assert.equal(readFileSync(join(first.snapshotDir, '_shared.md'), 'utf8'), '# shared\n');
    assert.equal(verifySnapshot({ ...first, commit, packId: 'java-spring' }), true);
    assert.equal(existsSync(join(first.snapshotDir, 'stack.json')), true);
    // meta 必须在包目录外：包目录内只能有真正的包文件。
    assert.equal(existsSync(first.metaFile), true);
    assert.equal(existsSync(join(first.snapshotDir, 'java-spring.meta.json')), false);

    const second = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'), loaderFiles: new Set(), pluginVersion: '1.7.0',
    });
    assert.equal(second.snapshotDir, first.snapshotDir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('快照被篡改后重新物化', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-tamper-'));
  try {
    const remote = makeGitRepo(base, {
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', detects: [],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
    });
    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    const first = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'),
    });
    writeFileSync(join(first.snapshotDir, '_shared.md'), '# hacked\n');
    const second = materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'),
    });
    assert.equal(readFileSync(join(second.snapshotDir, '_shared.md'), 'utf8'), '# shared\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('拒绝 ls-tree 中的符号链接模式', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-mode-'));
  try {
    const remote = makeGitRepo(base, {
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', detects: [],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
    });
    // 用 git 索引直接写入 120000 模式，避免依赖操作系统的符号链接权限。
    const target = join(base, 'link-target.txt');
    writeFileSync(target, 'target\n');
    const blob = git(remote, ['hash-object', '-w', '--', target]);
    git(remote, ['update-index', '--add', '--cacheinfo', `120000,${blob},stacks/java-spring/link.md`]);
    git(remote, ['commit', '-m', 'link']);

    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    assert.throws(() => materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'),
    }), /符号链接或子模块/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('离线模式下快照缺失直接报错，不落到 git 对象读取', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-snapshot-offline-'));
  try {
    const remote = makeGitRepo(base, {
      'stacks/java-spring/_shared.md': '# shared\n',
      'stacks/java-spring/stack.json': JSON.stringify({
        name: 'java-spring', version: '1.2.0', detects: [],
        files: { '_shared.md': contentHash('# shared\n') },
      }),
    });
    const { repoGit } = ensureRepo({ url: remote, cacheRoot: join(base, 'cache'), allowFile: true });
    const commit = resolveCommit({ repoGit, ref: 'main' });
    assert.throws(() => materializeSnapshot({
      repoGit, commit, packId: 'java-spring', packPath: 'stacks/java-spring',
      cacheRoot: join(base, 'cache'), offline: true,
    }), /离线模式下没有可用快照/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
