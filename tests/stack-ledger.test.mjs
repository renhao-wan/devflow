import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../scripts/lib/common.mjs';
import {
  stackPaths, readSources, writeSources, readLock, writeLock, renderLockYaml,
  managedStackNames, dropHubOwnership,
} from '../scripts/lib/stack-ledger.mjs';

test('账本缺失返回空，损坏时 fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ledger-'));
  try {
    assert.deepEqual(readSources(root), { schemaVersion: 1, packs: {} });
    const p = stackPaths(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(p.sources, '{ broken');
    assert.throws(() => readSources(root), /损坏/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('账本往返并推导受管栈', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ledger-write-'));
  try {
    writeSources(root, {
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', repo: 'https://example.com/r.git', packId: 'java-spring',
          path: 'stacks/java-spring', ref: 'main', commit: 'a'.repeat(40), version: '1.2.0', source: 'git',
        },
      },
    });
    const data = readSources(root);
    assert.equal(data.packs['java-spring'].version, '1.2.0');
    assert.deepEqual([...managedStackNames(data)], ['java-spring']);
    assert.equal(
      stackPaths(root).stackDir('java-spring'),
      join(root, '.claude', 'hub', 'stacks', 'java-spring'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lock 往返保留未知顶层标量字段', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-lock-'));
  try {
    const lock = {
      version: 1,
      futureField: 'keep-me',
      packs: {
        'java-spring': {
          installedAs: 'java-spring', repo: 'https://example.com/r.git', packId: 'java-spring',
          path: 'stacks/java-spring', ref: 'main', commit: 'b'.repeat(40), version: '1.2.0',
        },
      },
    };
    writeLock(root, lock);
    const text = readFileSync(stackPaths(root).lock, 'utf8');
    assert.match(text, /^version: 1/m);
    const parsed = parseYaml(text);
    assert.equal(parsed.futureField, 'keep-me');
    assert.equal(readLock(root).packs['java-spring'].commit, 'b'.repeat(40));
    assert.match(renderLockYaml(lock), /packs:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owner 转移删除旧 hub-sources 记录与 bases', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-owner-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.hub-sources.json'), JSON.stringify({
      schemaVersion: 3,
      files: {
        '.claude/hub/stacks/java-spring/_shared.md': { base: 'x', local: 'x' },
        '.claude/hub/stages/req/SKILL.md': { base: 'y', local: 'y' },
      },
    }));
    const baseDir = join(root, '.claude', '.hub-bases', 'stacks', 'java-spring');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, '_shared.md'), 'old');

    dropHubOwnership(root, 'java-spring');

    const data = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(data.files['.claude/hub/stacks/java-spring/_shared.md'], undefined);
    assert.ok(data.files['.claude/hub/stages/req/SKILL.md']);
    assert.equal(existsSync(baseDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
