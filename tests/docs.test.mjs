import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

function markdownLinks(body) {
  return [...body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
}

test('README 与 docs 中的相对链接均指向真实文件', () => {
  const files = [
    'README.md',
    'SECURITY.md',
    ...readdirSync(join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
  ];
  const broken = [];
  for (const rel of files) {
    for (const target of markdownLinks(read(rel))) {
      if (/^(https?:|mailto:|#)/i.test(target)) continue;
      const path = target.split('#')[0];
      if (!path) continue;
      const resolved = resolve(dirname(join(ROOT, ...rel.split('/'))), path);
      if (!existsSync(resolved)) broken.push(`${rel} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `存在失效的相对链接：\n${broken.join('\n')}`);
});

test('docs/README.md 覆盖 docs 下的所有文档', () => {
  const index = read('docs/README.md');
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md') && name !== 'README.md');
  for (const name of docs) {
    assert.match(index, new RegExp(name.replace('.', '\\.')), `docs/README.md 未列出 ${name}`);
  }
});

test('README 保留原生能力与 statusline 的关键入口', () => {
  const readme = read('README.md');
  for (const needle of ['docs/native-capabilities.md', '/rewind', '/worktree', 'statusLine', 'scripts/statusline.mjs']) {
    assert.ok(readme.includes(needle), `README 缺少 ${needle}`);
  }
});
