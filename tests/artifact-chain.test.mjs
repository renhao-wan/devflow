import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowOf, chainOf, normalizeFrom, archivePlanFor, staleDownstream,
  changeFromFor, staleKey, purgeRemainder,
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

test('purgeRemainder 只在链首 purge 时补齐其他流程的产物', () => {
  // 完整任务里追加的 debug.md 不在 full 链上，从链首 purge 时必须一起归档。
  assert.deepEqual(
    purgeRemainder(['req.md', 'plan.md', 'test.md', 'review.md', 'debug.md'], []),
    ['req.md', 'plan.md', 'debug.md', 'test.md', 'review.md'],
  );
  assert.deepEqual(purgeRemainder(['brief.md', 'test.md', 'debug.md'], []), ['brief.md', 'debug.md', 'test.md']);
  // 保留上游时（如 --from plan --purge）不改动归档范围。
  assert.deepEqual(purgeRemainder(['req.md', 'plan.md', 'debug.md'], ['req.md']), []);
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

test('过期关系带最小归档起点，test 晚于 review 只归档 review', () => {
  assert.equal(changeFromFor('req.md'), 'req');
  assert.equal(changeFromFor('brief.md'), 'req');
  assert.equal(changeFromFor('debug.md'), 'req');
  assert.equal(changeFromFor('plan.md'), 'plan');
  assert.equal(changeFromFor('test.md'), 'review');
  assert.equal(changeFromFor('review.md'), null);

  const chain = ['req.md', 'plan.md', 'test.md', 'review.md'];
  const stale = staleDownstream(chain, {
    'req.md': 5000, 'plan.md': 3500, 'test.md': 2000, 'review.md': 500,
  });
  assert.deepEqual(stale.map((item) => item.from), ['req', 'plan', 'review']);
  // 链上最早一条是推荐起点；一次 from=req 就能覆盖后面所有过期项。
  assert.equal(stale[0].from, 'req');
});

test('轻量流程的过期关系按链首产物映射到 req', () => {
  const lightFeature = staleDownstream(['brief.md', 'test.md', 'review.md'], {
    'brief.md': 9000, 'test.md': 7000, 'review.md': 5000,
  });
  assert.deepEqual(lightFeature.map((item) => item.from), ['req', 'review']);

  const lightBug = staleDownstream(['debug.md', 'test.md', 'review.md'], {
    'debug.md': 9000, 'test.md': 7000, 'review.md': 5000,
  });
  assert.deepEqual(lightBug.map((item) => item.from), ['req', 'review']);
});

test('staleKey 随任一产物 mtime 变化而失效', () => {
  const chain = ['plan.md', 'test.md'];
  const first = staleDownstream(chain, { 'plan.md': 3000, 'test.md': 1000 });
  const same = staleDownstream(chain, { 'plan.md': 3000, 'test.md': 1000 });
  const changed = staleDownstream(chain, { 'plan.md': 4000, 'test.md': 1000 });
  assert.equal(staleKey(first), staleKey(same));
  assert.notEqual(staleKey(first), staleKey(changed));
  assert.match(staleKey(first), /plan\.md@3000>test\.md@1000/);
});
