import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowOf, chainOf, normalizeFrom, archivePlanFor, staleDownstream,
} from '../scripts/lib/artifact-chain.mjs';

test('flowOf 按产物识别流程，完整流程优先', () => {
  assert.equal(flowOf(['req.md']), 'full');
  assert.equal(flowOf(['plan.md']), 'full');
  assert.equal(flowOf(['brief.md']), 'light-feature');
  assert.equal(flowOf(['debug.md']), 'light-bug');
  assert.equal(flowOf(['test.md', 'review.md']), 'unknown');
  assert.equal(flowOf(['req.md', 'brief.md']), 'full');
});

test('chainOf 返回对应流程的产物链', () => {
  assert.deepEqual(chainOf('full'), ['req.md', 'plan.md', 'test.md', 'review.md']);
  assert.deepEqual(chainOf('light-feature'), ['brief.md', 'test.md', 'review.md']);
  assert.deepEqual(chainOf('light-bug'), ['debug.md', 'test.md', 'review.md']);
  assert.deepEqual(chainOf('unknown'), []);
});

test('--from 支持 brief/debug 作为 req 的别名', () => {
  assert.equal(normalizeFrom('req'), 'req');
  assert.equal(normalizeFrom('brief'), 'req');
  assert.equal(normalizeFrom('debug'), 'req');
  assert.equal(normalizeFrom('plan'), 'plan');
  assert.equal(normalizeFrom('nope'), 'nope');
});

test('完整流程归档矩阵：req 与 plan 保留自身，test 与 review 归档自身', () => {
  const req = archivePlanFor('full', 'req');
  assert.deepEqual(req.files, ['plan.md', 'test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(req.keep, ['req.md']);
  assert.equal(req.selfArchived, false);

  const plan = archivePlanFor('full', 'plan');
  assert.deepEqual(plan.files, ['test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(plan.keep, ['req.md', 'plan.md']);
  assert.equal(plan.selfArchived, false);

  const testFile = archivePlanFor('full', 'test');
  assert.deepEqual(testFile.files, ['test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(testFile.keep, ['req.md', 'plan.md']);
  assert.equal(testFile.selfArchived, true);

  const review = archivePlanFor('full', 'review');
  assert.deepEqual(review.files, ['review.md', 'review-triage.json']);
  assert.deepEqual(review.keep, ['req.md', 'plan.md', 'test.md']);
  assert.equal(review.selfArchived, true);
});

test('--purge 只改变 req/plan，归档自身及下游', () => {
  const req = archivePlanFor('full', 'req', { purge: true });
  assert.deepEqual(req.files, ['req.md', 'plan.md', 'test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(req.keep, []);
  assert.equal(req.selfArchived, true);

  const plan = archivePlanFor('full', 'plan', { purge: true });
  assert.deepEqual(plan.files, ['plan.md', 'test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(plan.keep, ['req.md']);

  const testFile = archivePlanFor('full', 'test', { purge: true });
  assert.deepEqual(testFile.files, ['test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(testFile.keep, ['req.md', 'plan.md']);
});

test('轻量功能用 brief 作为起点，没有 plan 阶段', () => {
  const req = archivePlanFor('light-feature', 'req');
  assert.deepEqual(req.files, ['test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(req.keep, ['brief.md']);

  const testFile = archivePlanFor('light-feature', 'test');
  assert.deepEqual(testFile.files, ['test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(testFile.keep, ['brief.md']);

  const review = archivePlanFor('light-feature', 'review');
  assert.deepEqual(review.files, ['review.md', 'review-triage.json']);
  assert.deepEqual(review.keep, ['brief.md', 'test.md']);

  const plan = archivePlanFor('light-feature', 'plan');
  assert.ok(plan.error.includes('没有 plan'));
});

test('轻量修复用 debug 作为起点', () => {
  const req = archivePlanFor('light-bug', 'req');
  assert.deepEqual(req.files, ['test.md', 'review.md', 'review-triage.json']);
  assert.deepEqual(req.keep, ['debug.md']);

  const purge = archivePlanFor('light-bug', 'req', { purge: true });
  assert.deepEqual(purge.files, ['debug.md', 'test.md', 'review.md', 'review-triage.json']);
});

test('未知 --from 或未知流程返回错误', () => {
  assert.ok(archivePlanFor('full', 'implement').error.includes('未知的 --from'));
  assert.ok(archivePlanFor('full', '').error.includes('未知的 --from'));
  assert.ok(archivePlanFor('unknown', 'req').error.includes('无法识别流程'));
});

test('staleDownstream 只比较相邻项并跳过缺失文件', () => {
  const chain = ['req.md', 'plan.md', 'test.md', 'review.md'];
  const stale = staleDownstream(chain, {
    'req.md': 10000, 'plan.md': 7000, 'test.md': 4000, 'review.md': 1000,
  });
  assert.deepEqual(stale.map((item) => [item.upstream, item.downstream]), [
    ['req.md', 'plan.md'],
    ['plan.md', 'test.md'],
    ['test.md', 'review.md'],
  ]);

  const missing = staleDownstream(chain, { 'req.md': 5000, 'plan.md': 3000, 'test.md': 0 });
  assert.deepEqual(missing.map((item) => item.downstream), ['plan.md']);
});

test('staleDownstream 在容差内不报，且上游晚于下游才报', () => {
  const chain = ['req.md', 'plan.md'];
  assert.deepEqual(staleDownstream(chain, { 'req.md': 2000, 'plan.md': 1000 }), []);
  assert.deepEqual(staleDownstream(chain, { 'req.md': 1000, 'plan.md': 2000 }), []);
  assert.equal(staleDownstream(chain, { 'req.md': 2001, 'plan.md': 1000 }).length, 1);
  assert.equal(staleDownstream(chain, { 'req.md': 2002, 'plan.md': 1000 }).length, 1);
});
