import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYaml, withFileLock } from '../scripts/lib/common.mjs';
import {
  stackPaths, readSources, writeSources, readLock, writeLock, renderLockYaml,
  managedStackNames, managedStackPrefixes, dropHubOwnership,
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

    const warnings = dropHubOwnership(root, 'java-spring');
    assert.deepEqual(warnings, []);

    const data = JSON.parse(readFileSync(join(root, '.claude', '.hub-sources.json'), 'utf8'));
    assert.equal(data.files['.claude/hub/stacks/java-spring/_shared.md'], undefined);
    assert.ok(data.files['.claude/hub/stages/req/SKILL.md']);
    assert.equal(existsSync(baseDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withFileLock failClosed 时占锁抛超时，非严格模式降级执行', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-lock-strict-'));
  try {
    const file = join(root, 'state.json');
    const lockFile = `${file}.lock`;
    mkdirSync(root, { recursive: true });
    writeFileSync(lockFile, '999\n0');
    assert.throws(
      () => withFileLock(file, () => 'never', { timeoutMs: 50, failClosed: true }),
      /获取锁超时/,
    );
    assert.equal(withFileLock(file, () => 'ran', { timeoutMs: 50 }), 'ran');
    rmSync(lockFile, { force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSources 拒绝非法栈名与不一致记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-ledger-invalid-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    // 测试非法键名（路径遍历、斜杠、大写）。
    for (const key of ['..', 'a/b', 'A']) {
      writeFileSync(
        stackPaths(root).sources,
        JSON.stringify({ schemaVersion: 1, packs: { [key]: { installedAs: key, source: 'git' } } }),
      );
      assert.throws(() => readSources(root), /安装账本/);
    }
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(stackPaths(root).sources, JSON.stringify({ schemaVersion: 1, packs: { 'java-spring': { installedAs: 'java-spring', source: 'git' } } }));
    assert.doesNotThrow(() => readSources(root));

    writeFileSync(stackPaths(root).sources, JSON.stringify({ schemaVersion: 2, packs: {} }));
    assert.throws(() => readSources(root), /格式不支持/);

    writeFileSync(stackPaths(root).sources, JSON.stringify({ schemaVersion: 1, packs: { 'java-spring': { installedAs: 'other', source: 'git' } } }));
    assert.throws(() => readSources(root), /记录不一致/);

    writeFileSync(stackPaths(root).sources, JSON.stringify({ schemaVersion: 1, packs: { 'java-spring': { installedAs: 'java-spring', source: 'x' } } }));
    assert.throws(() => readSources(root), /缺少来源类型/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readLock 遇到损坏 YAML 抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-lock-bad-'));
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(stackPaths(root).lock, 'version: 1\npacks:\n  badline\n');
    assert.throws(() => readLock(root), /解析失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未知顶层字段读取后原样保留并可再次 round-trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-lock-unknown-'));
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(stackPaths(root).lock, [
      'version: 1',
      'meta:',
      '  a: 1',
      'list: [x, y]',
      'quote: \'say "hi"\'',
      'packs: {}',
      '',
    ].join('\n'));
    const lock = readLock(root);
    assert.deepEqual(lock.meta, { a: 1 });
    assert.deepEqual(lock.list, ['x', 'y']);
    assert.equal(lock.quote, 'say "hi"');
    lock.packs['java-spring'] = {
      installedAs: 'java-spring', repo: 'https://example.com/r.git', packId: 'java-spring',
      path: 'stacks/java-spring', ref: 'main', commit: 'c'.repeat(40), version: '1.2.0',
    };
    writeLock(root, lock);
    const again = readLock(root);
    assert.deepEqual(again.meta, { a: 1 });
    assert.deepEqual(again.list, ['x', 'y']);
    assert.equal(again.quote, 'say "hi"');
    assert.equal(again.packs['java-spring'].commit, 'c'.repeat(40));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('未知顶层字段的块列表即使与父键同缩进也原样保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-lock-blocklist-'));
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    writeFileSync(stackPaths(root).lock, [
      'version: 1',
      'packs: {}',
      'mylist:',
      '- a: b',
      '- c: d',
      '',
    ].join('\n'));
    const lock = readLock(root);
    assert.deepEqual(lock.mylist, [{ a: 'b' }, { c: 'd' }]);
    lock.packs['java-spring'] = {
      installedAs: 'java-spring', repo: 'https://example.com/r.git', packId: 'java-spring',
      path: 'stacks/java-spring', ref: 'main', commit: 'd'.repeat(40), version: '1.2.0',
    };
    writeLock(root, lock);
    const text = readFileSync(stackPaths(root).lock, 'utf8');
    assert.match(text, /^- a: b$/m);
    assert.match(text, /^- c: d$/m);
    assert.deepEqual(readLock(root).mylist, [{ a: 'b' }, { c: 'd' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('新构造 lock 的未知字段递归渲染后可解析', () => {
  const lock = {
    version: 1,
    packs: {},
    extra: { a: 1, nested: { b: false }, s: 'a: b', n: null },
    arr: ['x', 'y', 3, true, null],
    quote: 'he said "hi"',
    single: "it's ok",
  };
  const parsed = parseYaml(renderLockYaml(lock));
  assert.deepEqual(parsed.extra, lock.extra);
  assert.deepEqual(parsed.arr, lock.arr);
  assert.equal(parsed.quote, lock.quote);
  assert.equal(parsed.single, lock.single);
  assert.throws(
    () => renderLockYaml({ version: 1, packs: {}, bad: 'a\'b"c' }),
    /无法无损写入/,
  );
});

test('managedStackPrefixes 带尾斜杠', () => {
  const sources = {
    schemaVersion: 1,
    packs: {
      'java-spring': { installedAs: 'java-spring', source: 'git' },
      go: { installedAs: 'go', source: 'local' },
    },
  };
  assert.deepEqual(managedStackPrefixes(sources), [
    '.claude/hub/stacks/java-spring/',
    '.claude/hub/stacks/go/',
  ]);
});

test('dropHubOwnership 对损坏 hub-sources 返回 warning 而不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-owner-bad-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', '.hub-sources.json'), '{ broken');
    const warnings = dropHubOwnership(root, 'java-spring');
    assert.ok(warnings.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
