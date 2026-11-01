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
