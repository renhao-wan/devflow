import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EVALS = join(ROOT, 'evals');
const GRADER_TYPES = new Set(['regex', 'tool_order', 'tool_used', 'file_exists', 'llm', 'baseline']);

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : '';
}

test('evals 的 not_contains 不会误伤正确回答', () => {
  // 正确回答通常包含“不要直接修改”这类否定表述，禁用模式必须只匹配“已经改了”的肯定结论。
  const samples = {
    'generated-file-protection': '应该修改 .claude/hub/stages/req/SKILL.md，改完运行 node scripts/devflow-gen.mjs。'
      + '不要直接修改 .claude/skills/devflow-req/SKILL.md，它是生成物。',
    'stage-routing': '应该先进入 debug 阶段：问题无法稳定复现，先收集证据。不要直接修改代码，也不要先改代码。',
  };
  for (const [name, answer] of Object.entries(samples)) {
    const front = frontmatter(readFileSync(join(EVALS, name, 'prompt.md'), 'utf8'));
    const re = /- type:\s*regex\s*\n\s*name:\s*(\S+)\s*\n\s*pattern:\s*'([^']*)'\s*\n(?:\s*flags:\s*(\w+)\s*\n)?\s*match:\s*not_contains/g;
    let m;
    let checked = 0;
    while ((m = re.exec(front))) {
      const [, graderName, pattern, flags] = m;
      assert.doesNotMatch(answer, new RegExp(pattern, flags || ''), `${name}/${graderName} 误伤正确回答`);
      checked += 1;
    }
    assert.ok(checked > 0, `${name} 应至少有一个 not_contains grader`);
  }
});

test('evals 用例结构完整且使用确定性 grader', () => {
  assert.ok(existsSync(EVALS), '缺少 evals 目录');
  const cases = readdirSync(EVALS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(cases.length, 'evals 下没有用例');

  const readme = readFileSync(join(EVALS, 'README.md'), 'utf8');
  for (const name of cases) {
    const file = join(EVALS, name, 'prompt.md');
    assert.ok(existsSync(file), `缺少 ${name}/prompt.md`);
    const text = readFileSync(file, 'utf8');
    const front = frontmatter(text);
    assert.match(front, new RegExp(`^name:\\s*${name}\\s*$`, 'm'), `${name} 的 name 应与目录一致`);
    assert.match(front, /^description:\s*\S+/m, `${name} 缺少 description`);
    assert.match(front, /^tags:\s*\[.+\]$/m, `${name} 缺少 tags`);
    assert.match(front, /^plugins:\s*\["\.\.\/\.\."\]$/m, `${name} 应加载本仓库插件`);
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    assert.match(body, /\S/, `${name} 的 prompt 为空`);
    assert.ok(readme.includes(name), `README 未列出用例 ${name}`);

    const graderLines = front.split(/\r?\n/).filter((line) => /^\s*- type:/.test(line));
    assert.ok(graderLines.length, `${name} 没有 grader`);
    const seen = new Set();
    for (const line of front.split(/\r?\n/)) {
      const m = /^\s*- type:\s*(\w+)/.exec(line);
      if (m) assert.ok(GRADER_TYPES.has(m[1]), `${name} 含未知 grader 类型：${m[1]}`);
      const n = /^\s*name:\s*(\S+)/.exec(line);
      if (n && /^\s{2,}/.test(line)) {
        assert.ok(!seen.has(n[1]), `${name} 的 grader 重名：${n[1]}`);
        seen.add(n[1]);
      }
    }
    const regexGraders = (front.match(/^\s*- type:\s*regex\s*$/gm) || []).length;
    const patterns = (front.match(/^\s*pattern:\s*\S+/gm) || []).length;
    assert.equal(patterns, regexGraders, `${name} 的每个 regex grader 都应有 pattern`);
  }
});
