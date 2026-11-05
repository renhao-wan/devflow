// tests/stack-install.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../scripts/lib/common.mjs';
import { classifyInstall, targetSnapshot } from '../scripts/lib/stack-install.mjs';

function packOf(files) {
  return {
    manifest: { name: 'java-spring', version: '1.2.0' },
    files: Object.entries(files).map(([rel, text]) => ({ rel, text, hash: contentHash(text) })),
  };
}

test('目标状态机覆盖设计文档的 8 种组合', () => {
  const installedAs = 'java-spring';
  const record = { installedAs };
  assert.equal(classifyInstall({ installedAs, targetExists: false, record: null, lockEntry: null }), 'fresh');
  assert.equal(classifyInstall({ installedAs, targetExists: false, record, lockEntry: {} }), 'restore');
  assert.equal(classifyInstall({ installedAs, targetExists: false, record, lockEntry: null }), 'restore');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: true, record, lockEntry: {} }), 'update');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: true, record, lockEntry: null }), 'update');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: true, record: null, lockEntry: {} }), 'adopt');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: false, record: null, lockEntry: {}, force: false }), 'conflict');
  assert.equal(classifyInstall({ installedAs, targetExists: true, targetMatches: false, record: null, lockEntry: {}, force: true }), 'takeover');
  assert.equal(classifyInstall({ installedAs, targetExists: true, record: { installedAs: 'other' }, lockEntry: null }), 'other-owner');
  assert.equal(classifyInstall({ installedAs, targetExists: true, record: null, lockEntry: null, force: true }), 'takeover');
});

test('同一 installedAs 但来源不同时拒绝', () => {
  const installedAs = 'java-spring';
  const gitRecord = { installedAs, source: 'git', repo: 'https://example.com/a.git', packId: 'java-spring' };
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: gitRecord, lockEntry: {},
    source: { type: 'git', repo: 'https://example.com/b.git', packId: 'java-spring' },
  }), 'other-owner');
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: gitRecord, lockEntry: {},
    source: { type: 'git', repo: 'https://example.com/a.git', packId: 'other' },
  }), 'other-owner');
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: gitRecord, lockEntry: {},
    source: { type: 'git', repo: 'https://example.com/a.git', packId: 'java-spring' },
  }), 'update');
  const localRecord = { installedAs, source: 'local', localPath: '/a', packId: 'java-spring' };
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: localRecord, lockEntry: {},
    source: { type: 'local', localPath: '/b', packId: 'java-spring' },
  }), 'other-owner');
  assert.equal(classifyInstall({
    installedAs, targetExists: true, record: localRecord, lockEntry: {},
    source: { type: 'local', localPath: '/a', packId: 'java-spring' },
  }), 'update');
});

test('targetSnapshot 报告匹配、改动与缺失文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-target-'));
  try {
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# shared\n');
    writeFileSync(join(dir, 'extra.md'), '# extra\n');
    const pack = packOf({ '_shared.md': '# shared\n', 'plan.md': '# plan\n' });
    const snap = targetSnapshot(root, 'java-spring', pack);
    assert.equal(snap.exists, true);
    assert.equal(snap.matches, false);
    assert.deepEqual(snap.missing, ['plan.md']);
    assert.deepEqual(snap.changed, []);
    assert.deepEqual(snap.extra, ['extra.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
