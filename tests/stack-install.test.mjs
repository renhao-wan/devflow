// tests/stack-install.test.mjs
import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../scripts/lib/common.mjs';
import { readSources } from '../scripts/lib/stack-ledger.mjs';
import {
  applyInstall, classifyInstall, targetSnapshot, applyPackUpdate, planPackUpdate, adoptExisting,
} from '../scripts/lib/stack-install.mjs';

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

test('全新安装写入目录、bases 与账本', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-'));
  try {
    const pack = packOf({ '_shared.md': '# shared\n', 'plan.md': '# plan\n' });
    const result = applyInstall({
      root,
      installedAs: 'java-spring',
      pack,
      source: { type: 'local', localPath: '/tmp/stacks', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    });
    assert.equal(result.action, 'fresh');
    assert.equal(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8'), '# plan\n');
    assert.equal(readFileSync(join(root, '.claude', '.stack-bases', 'java-spring', 'plan.md'), 'utf8'), '# plan\n');
    const ledger = readSources(root);
    assert.equal(ledger.packs['java-spring'].source, 'local');
    assert.equal(
      ledger.packs['java-spring'].files['.claude/hub/stacks/java-spring/plan.md'].base,
      contentHash('# plan\n'),
    );
    // local 来源不维护 stack-lock.yaml，不能凭空生成空 lock 文件。
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stack-lock.yaml')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('第 4 步移动 bases 失败时恢复已移走的旧目录，账本保持不变', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-rollback-'));
  try {
    const target = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    const bases = join(root, '.claude', '.stack-bases', 'java-spring');
    mkdirSync(target, { recursive: true });
    mkdirSync(bases, { recursive: true });
    writeFileSync(join(target, '_shared.md'), '# old\n');
    writeFileSync(join(bases, '_shared.md'), '# old\n');
    writeFileSync(join(root, '.claude', '.stack-sources.json'), JSON.stringify({
      schemaVersion: 1,
      packs: {
        'java-spring': {
          installedAs: 'java-spring', source: 'local', localPath: '/new', packId: 'java-spring',
          path: 'stacks/java-spring', version: '1.0.0',
          files: { '.claude/hub/stacks/java-spring/_shared.md': { base: contentHash('# old\n'), local: contentHash('# old\n') } },
        },
      },
    }, null, 2));
    const before = readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8');

    let renamedBases = false;
    const ops = {
      renameSync(from, to) {
        if (from === bases) {
          renamedBases = true;
          throw new Error('模拟移动 bases 失败');
        }
        return renameSync(from, to);
      },
      rmSync,
    };

    assert.throws(() => applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# new\n' }),
      source: { type: 'local', localPath: '/new', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: readSources(root),
      noGen: true,
      ops,
    }), /模拟移动 bases 失败/);
    assert.equal(renamedBases, true);
    assert.equal(readFileSync(join(target, '_shared.md'), 'utf8'), '# old\n');
    assert.equal(readFileSync(join(bases, '_shared.md'), 'utf8'), '# old\n');
    assert.equal(readFileSync(join(root, '.claude', '.stack-sources.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无账本且已有目录时默认拒绝，--force 才接管', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-force-'));
  try {
    mkdirSync(join(root, '.claude', 'hub', 'stacks', 'java-spring'), { recursive: true });
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), '# local\n');
    const args = {
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# pack\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    };
    assert.throws(() => applyInstall(args), /--force/);
    const result = applyInstall({ ...args, force: true });
    assert.equal(result.action, 'takeover');
    assert.equal(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), '# pack\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目标目录被 junction 引到项目外时拒绝安装', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'devflow-install-outside-'));
  try {
    mkdirSync(join(root, '.claude', 'hub'), { recursive: true });
    symlinkSync(outside, join(root, '.claude', 'hub', 'stacks'), 'junction');
    assert.throws(() => applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    }), /越界/);
    assert.equal(existsSync(join(outside, 'java-spring')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('非法栈名被拒绝且不移动原有目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-name-'));
  try {
    const stacks = join(root, '.claude', 'hub', 'stacks');
    mkdirSync(stacks, { recursive: true });
    writeFileSync(join(stacks, 'keep.md'), '# keep\n');
    assert.throws(() => applyInstall({
      root,
      installedAs: '../stacks',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      force: true,
      noGen: true,
    }), /栈名不合法/);
    assert.equal(readFileSync(join(stacks, 'keep.md'), 'utf8'), '# keep\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.stack-bases 被 junction 引到项目外时拒绝安装', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-bases-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'devflow-install-bases-outside-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    symlinkSync(outside, join(root, '.claude', '.stack-bases'), 'junction');
    assert.throws(() => applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    }), /越界/);
    assert.equal(existsSync(join(outside, 'java-spring')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('.stack-trash 被 junction 引到项目外时拒绝安装', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-trash-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'devflow-install-trash-outside-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    symlinkSync(outside, join(root, '.claude', '.stack-trash'), 'junction');
    assert.throws(() => applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
    }), /越界/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring')), false);
    assert.equal(existsSync(join(outside, 'java-spring')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('提交后清理备份失败只警告，不跳过后续步骤', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-cleanup-'));
  try {
    const warnings = [];
    const result = applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      noGen: true,
      ops: {
        renameSync,
        rmSync(from, options) {
          if (String(from).includes('.stack-trash')) throw new Error('模拟清理失败');
          return rmSync(from, options);
        },
      },
      onWarn: (message) => warnings.push(message),
    });
    assert.equal(result.action, 'fresh');
    assert.equal(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), '# shared\n');
    assert.equal(readSources(root).packs['java-spring'].installedAs, 'java-spring');
    assert.ok(warnings.some((message) => message.includes('清理')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('生成技能失败不回滚，只警告', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-install-gen-'));
  try {
    const warnings = [];
    const result = applyInstall({
      root,
      installedAs: 'java-spring',
      pack: packOf({ '_shared.md': '# shared\n' }),
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
      generate: () => { throw new Error('模拟生成失败'); },
      onWarn: (message) => warnings.push(message),
    });
    assert.equal(result.action, 'fresh');
    assert.equal(readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', '_shared.md'), 'utf8'), '# shared\n');
    assert.equal(readSources(root).packs['java-spring'].installedAs, 'java-spring');
    assert.ok(warnings.some((message) => message.includes('生成技能失败')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('更新合并本地改动、保留未改文件并删除包删除的干净文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-update-'));
  try {
    const source = { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' };
    const v1 = packOf({ '_shared.md': '# shared\n', 'plan.md': 'a\nb\nc\n', 'old.md': '# old\n' });
    applyInstall({ root, installedAs: 'java-spring', pack: v1, source, sources: { schemaVersion: 1, packs: {} }, noGen: true });
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'a\nLOCAL\nc\n');

    const v2 = packOf({ '_shared.md': '# shared\n', 'plan.md': 'a\nb\nC2\n' });
    const plan = planPackUpdate({ root, installedAs: 'java-spring', pack: v2, sources: readSources(root) });
    assert.ok(plan.ops.some((op) => op.rel === 'old.md' && op.type === 'delete'));
    assert.ok(plan.ops.some((op) => op.rel === 'plan.md' && op.type === 'write'));

    applyPackUpdate({ root, installedAs: 'java-spring', pack: v2, source, sources: readSources(root), noGen: true });
    const merged = readFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'plan.md'), 'utf8');
    assert.match(merged, /LOCAL/);
    assert.match(merged, /C2/);
    assert.equal(existsSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'old.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('包删除本地改过的文件时保留并给警告', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-update-keep-'));
  try {
    const source = { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' };
    applyInstall({
      root, installedAs: 'java-spring', source, noGen: true,
      pack: packOf({ '_shared.md': '# shared\n', 'old.md': '# old\n' }),
      sources: { schemaVersion: 1, packs: {} },
    });
    writeFileSync(join(root, '.claude', 'hub', 'stacks', 'java-spring', 'old.md'), '# local edit\n');
    const plan = planPackUpdate({
      root, installedAs: 'java-spring', pack: packOf({ '_shared.md': '# shared\n' }), sources: readSources(root),
    });
    assert.ok(plan.ops.some((op) => op.rel === 'old.md' && op.type === 'keep'));
    assert.match(plan.warnings.join('\n'), /本地改过/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adoptExisting 为内容一致目录补账本与 bases', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-adopt-'));
  try {
    const pack = packOf({ '_shared.md': '# shared\n' });
    const dir = join(root, '.claude', 'hub', 'stacks', 'java-spring');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_shared.md'), '# shared\n');
    adoptExisting({
      root, installedAs: 'java-spring', pack,
      source: { type: 'local', localPath: '/x', packId: 'java-spring', path: 'stacks/java-spring' },
      sources: { schemaVersion: 1, packs: {} },
    });
    assert.equal(readSources(root).packs['java-spring'].files['.claude/hub/stacks/java-spring/_shared.md'].base, contentHash('# shared\n'));
    assert.equal(readFileSync(join(root, '.claude', '.stack-bases', 'java-spring', '_shared.md'), 'utf8'), '# shared\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
