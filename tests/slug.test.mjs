import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MISSING, validSlug, resolveSlug } from '../scripts/lib/slug.mjs';

test('validSlug 接受普通的单段任务名', () => {
  for (const slug of ['demo', 'fix-login', 'v1.2_task', 'A1']) {
    assert.equal(validSlug(slug), true, slug);
  }
});

test('validSlug 拒绝隐藏目录、路径分隔符与首尾空格', () => {
  for (const slug of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'demo ', ' demo', 'a..b']) {
    assert.equal(validSlug(slug), false, JSON.stringify(slug));
  }
});

test('validSlug 拒绝非字符串与超长名称', () => {
  for (const slug of [null, undefined, 42, {}, ['demo']]) {
    assert.equal(validSlug(slug), false, String(slug));
  }
  assert.equal(validSlug('a'.repeat(80)), true);
  assert.equal(validSlug('a'.repeat(81)), false);
});

test('resolveSlug 对非法 slug 直接报错，对合法但不存在的 slug 返回 MISSING', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-slug-'));
  try {
    assert.throws(() => resolveSlug(root, '.hidden'), /非法的 slug/);
    assert.throws(() => resolveSlug(root, 'a/b'), /非法的 slug/);
    assert.equal(resolveSlug(root, 'demo'), MISSING);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSlug 拒绝指向项目外的 slug 目录', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-slug-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'devflow-slug-outside-'));
  try {
    mkdirSync(join(root, 'docs', 'devflow'), { recursive: true });
    try {
      symlinkSync(outside, join(root, 'docs', 'devflow', 'linked'), 'junction');
    } catch {
      t.skip('当前环境不允许创建 junction');
      return;
    }
    assert.throws(() => resolveSlug(root, 'linked'), /越界/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
