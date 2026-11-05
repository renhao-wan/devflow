import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureRepo, resolveCommit, fetchCommit, refreshRef,
} from '../scripts/lib/stack-fetch.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
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
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repo, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  return repo;
}

test('裸缓存可重复创建并解析 ref', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-'));
  try {
    const remote = makeGitRepo(base, { 'index.json': '{}' });
    const cacheRoot = join(base, 'cache');
    const first = ensureRepo({ url: remote, cacheRoot, allowFile: true });
    const second = ensureRepo({ url: remote, cacheRoot, allowFile: true });
    assert.equal(first.repoGit, second.repoGit);
    assert.equal(existsSync(first.repoGit), true);
    const commit = resolveCommit({ repoGit: first.repoGit, ref: 'main' });
    assert.match(commit, /^[0-9a-f]{40}$/);
    fetchCommit({ repoGit: first.repoGit, commit, ref: 'main' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('离线且缓存不存在时明确失败', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-offline-'));
  try {
    assert.throws(
      () => ensureRepo({ url: 'https://example.com/r.git', cacheRoot: join(base, 'cache'), offline: true }),
      /离线/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refreshRef 把 ref 更新到远程最新 commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-fetch-refresh-'));
  try {
    const remote = makeGitRepo(base, { 'index.json': '{}' });
    const cacheRoot = join(base, 'cache');
    const { repoGit } = ensureRepo({ url: remote, cacheRoot, allowFile: true });
    const stale = resolveCommit({ repoGit, ref: 'main' });
    assert.equal(stale, git(remote, ['rev-parse', 'HEAD']));

    writeFileSync(join(remote, 'index.json'), '{"packs":{}}');
    git(remote, ['add', '.']);
    git(remote, ['commit', '-m', 'second']);
    const latest = git(remote, ['rev-parse', 'HEAD']);
    assert.notEqual(latest, stale);

    refreshRef({ repoGit, ref: 'main' });
    assert.equal(resolveCommit({ repoGit, ref: 'main' }), latest);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
