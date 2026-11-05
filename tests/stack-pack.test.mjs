import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StackPackError, normalizeRepoUrl, repoCacheId, readIndex, resolveIndexPack,
} from '../scripts/lib/stack-pack.mjs';

test('仓库 URL 只接受白名单协议并拒绝凭据', () => {
  assert.equal(
    normalizeRepoUrl('https://github.com/org/devflow-stacks.git'),
    'https://github.com/org/devflow-stacks.git',
  );
  assert.equal(normalizeRepoUrl('git@github.com:org/devflow-stacks.git'), 'git@github.com:org/devflow-stacks.git');
  for (const bad of [
    'http://github.com/org/repo',
    'file:///tmp/repo',
    'https://user:pass@github.com/org/repo',
    'ssh://user:pass@github.com/org/repo',
    '-uhttps://github.com/org/repo',
    'ext::sh -c echo',
    'transport::http',
  ]) {
    assert.throws(() => normalizeRepoUrl(bad), StackPackError, bad);
  }
});

test('仓库 URL 错误消息不回显凭据', () => {
  for (const input of [
    'http://alice:s3cret@host/repo',
    '-uhttp://alice:s3cret@host/repo',
    'https://alice:s3cret@host/repo',
    'ssh://alice:s3cret@host/repo',
  ]) {
    assert.throws(
      () => normalizeRepoUrl(input),
      (err) => err instanceof StackPackError && !err.message.includes('s3cret'),
    );
  }
});

test('repoCacheId 稳定且不含凭据', () => {
  const a = repoCacheId('https://github.com/org/devflow-stacks.git');
  const b = repoCacheId('https://github.com/org/devflow-stacks.git');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('index.json 校验 pack 路径必须留在仓库内', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-index-'));
  try {
    writeFileSync(join(base, 'index.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          title: 'Spring',
          path: 'stacks/java-spring',
          detects: ['java-maven'],
        },
        escape: { path: '../outside', detects: [] },
      },
    }));
    const index = readIndex(base);
    assert.equal(index.packs['java-spring'].path, 'stacks/java-spring');
    assert.throws(() => resolveIndexPack(index, 'escape', base), /路径越界/);
    assert.throws(() => resolveIndexPack(index, 'missing', base), /不存在/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('index.json 不接受未知 schemaVersion 或缺字段', () => {
  const base = mkdtempSync(join(tmpdir(), 'devflow-index-bad-'));
  try {
    writeFileSync(join(base, 'index.json'), JSON.stringify({ schemaVersion: 2, packs: {} }));
    assert.throws(() => readIndex(base), /schemaVersion/);
    writeFileSync(join(base, 'index.json'), JSON.stringify({ schemaVersion: 1, packs: { x: { detects: [] } } }));
    assert.throws(() => readIndex(base), /path/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
