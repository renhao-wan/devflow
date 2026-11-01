import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '../scripts/lib/common.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

test('插件版本在 plugin.json、package.json、marketplace.json 中一致', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  const entry = (market.plugins || []).find((p) => p.name === plugin.name);
  assert.equal(pkg.version, plugin.version, 'package.json 版本应与 plugin.json 一致');
  assert.ok(entry, 'marketplace 应包含同名插件条目');
  assert.equal(entry.version, plugin.version, 'marketplace 插件条目版本应与 plugin.json 一致');
  assert.equal(market.metadata?.version, plugin.version, 'marketplace metadata 版本应与 plugin.json 一致');
});

test('hooks.json 引用的脚本真实存在', () => {
  const hooks = JSON.parse(read('hooks/hooks.json'));
  const commands = [];
  for (const groups of Object.values(hooks.hooks || {})) {
    for (const group of groups) {
      for (const hook of group.hooks || []) commands.push(hook.command);
    }
  }
  assert.ok(commands.length, 'hooks.json 未注册任何钩子');
  for (const command of commands) {
    const m = /hooks[\\/]scripts[\\/]([\w.-]+\.mjs)/.exec(command);
    assert.ok(m, `无法从钩子命令中解析脚本：${command}`);
    assert.ok(existsSync(join(ROOT, 'hooks', 'scripts', m[1])), `缺少钩子脚本 ${m[1]}`);
  }
});

test('阶段入口技能均带 name 与 description，危险命令禁止模型自动调用', () => {
  const entries = ['req', 'plan', 'implement', 'test', 'review', 'debug',
    'init', 'doctor', 'upstream', 'ship', 'sync'];
  for (const name of entries) {
    const fm = parseFrontmatter(read(`skills/${name}/SKILL.md`));
    assert.equal(fm.name, name, `${name} 的 name 应为 ${name}`);
    assert.ok(fm.description, `${name} 缺少 description`);
  }
  for (const name of ['init', 'upstream', 'ship', 'sync']) {
    const fm = parseFrontmatter(read(`skills/${name}/SKILL.md`));
    assert.equal(fm['disable-model-invocation'], 'true', `${name} 应禁止模型自动调用`);
  }
  assert.equal(existsSync(join(ROOT, 'commands')), false, 'commands 已迁移为 skills');
});

test('技能与子代理均带 name 与 description', () => {
  const skills = join(ROOT, 'skills');
  for (const dir of readdirSync(skills, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const file = `skills/${dir.name}/SKILL.md`;
    assert.ok(existsSync(join(ROOT, ...file.split('/'))), `缺少 ${file}`);
    const fm = parseFrontmatter(read(file));
    assert.ok(fm.name, `${file} 缺少 name`);
    assert.ok(fm.description, `${file} 缺少 description`);
  }

  const agents = join(ROOT, 'agents');
  for (const file of readdirSync(agents).filter((f) => f.endsWith('.md'))) {
    const fm = parseFrontmatter(read(`agents/${file}`));
    assert.ok(fm.name, `${file} 缺少 name`);
    assert.ok(fm.description, `${file} 缺少 description`);
  }
});
