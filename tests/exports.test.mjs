import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as trace from '../scripts/lib/trace.mjs';
import * as ecosystem from '../scripts/lib/ecosystem.mjs';
import * as overview from '../scripts/lib/overview.mjs';

// 只在模块内使用的辅助函数不应出现在公共导出面：调用方多了就难以重构。
test('trace 只导出跨模块使用的解析结果', () => {
  for (const name of ['normalizeId', 'parseAcceptance', 'parsePlanCoverage', 'parseTestCoverage']) {
    assert.equal(trace[name], undefined, `${name} 不应被导出`);
  }
  for (const name of ['parseReviewCoverage', 'buildTrace', 'traceFor', 'summarizeTrace']) {
    assert.equal(typeof trace[name], 'function', `${name} 应保持导出`);
  }
});

test('ecosystem 不导出内部常量表', () => {
  for (const name of ['STAGE_CAPABILITY', 'CATALOG']) {
    assert.equal(ecosystem[name], undefined, `${name} 不应被导出`);
  }
});

test('overview 不导出内部拼装函数', () => {
  for (const name of ['scanEntrypoints', 'buildAutoSection']) {
    assert.equal(overview[name], undefined, `${name} 不应被导出`);
  }
});
