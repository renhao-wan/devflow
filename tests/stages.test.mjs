import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStages } from '../scripts/lib/stages.mjs';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'devflow-stages-'));
  mkdirSync(join(root, '.claude', 'hub', 'stages', 'plan'), { recursive: true });
  mkdirSync(join(root, '.claude', 'hub', 'stages', 'req'), { recursive: true });
  return root;
}

test('显式 stages 优先于目录扫描，空数组表示不启用', () => {
  const root = makeRoot();
  try {
    const explicit = resolveStages({ stages: ['review'] }, root);
    assert.deepEqual(explicit, { stages: ['review'], error: null });

    const empty = resolveStages({ stages: [] }, root);
    assert.deepEqual(empty, { stages: [], error: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stages 非列表属于配置错误，不回退扫描', () => {
  const root = makeRoot();
  try {
    const plan = resolveStages({ stages: 'req,plan' }, root);
    assert.deepEqual(plan.stages, []);
    assert.match(plan.error, /必须是列表/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺少或留空 stages 时按目录排序扫描', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(resolveStages({}, root), { stages: ['plan', 'req'], error: null });
    assert.deepEqual(resolveStages({ stages: null }, root), { stages: ['plan', 'req'], error: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
