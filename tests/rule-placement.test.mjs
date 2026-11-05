import { test } from 'node:test';
import './support.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '../scripts/lib/common.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

test('规则落位技能带 name 与触发导向的 description', () => {
  const text = read('skills/devflow-rule-placement/SKILL.md');
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, 'devflow-rule-placement');
  assert.ok(fm.description);
  assert.match(fm.description, /rule|convention|rule placement/i);
});

test('规则落位技能覆盖四个目录、gen 时机与 doctor', () => {
  const text = read('skills/devflow-rule-placement/SKILL.md');
  for (const term of ['_shared/', 'stages/', 'stacks/', 'overrides/', 'devflow-gen.mjs', 'devflow-doctor.mjs']) {
    assert.ok(text.includes(term), `缺少 ${term}`);
  }
  assert.match(text, /只修改已有/);
  assert.match(text, /不需要 gen/);
  assert.match(text, /草稿标记/);
});

test('规则落位技能保持门禁与生成物边界', () => {
  const text = read('skills/devflow-rule-placement/SKILL.md');
  assert.match(text, /不得放宽阶段门禁与安全底线/);
  assert.match(text, /不直接修改 `\.claude\/skills\/devflow-\*`/);
  assert.match(text, /不把规则写到用户 home/);
});

test('hub 管理、工程流程与 init 技能都指向规则落位技能', () => {
  for (const rel of [
    'skills/devflow-hub-management/SKILL.md',
    'skills/devflow-engineering-flow/SKILL.md',
    'skills/init/SKILL.md',
  ]) {
    assert.match(read(rel), /devflow-rule-placement/, `${rel} 未引用落位技能`);
  }
});

test('六个阶段模板在边界中提示规则落位', () => {
  for (const stage of ['req', 'plan', 'implement', 'test', 'review', 'debug']) {
    const text = read(`templates/stages/${stage}/SKILL.md`);
    assert.match(text, /devflow-rule-placement/, `${stage} 模板缺少落位提示`);
    assert.match(text, /不直接改 `\.claude\/skills\/devflow-\*` 投影/);
  }
});
