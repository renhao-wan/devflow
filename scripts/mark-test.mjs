#!/usr/bin/env node
import { join } from 'node:path';
import { isMain, projectRoot, argValue, updateJson } from './lib/common.mjs';

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const command = argValue(argv, '--command', null);
  const file = join(root, '.claude', '.devflow-state.json');
  const state = updateJson(file, (current) => {
    const next = current && typeof current === 'object' ? current : {};
    next.lastTestPassedAt = new Date().toISOString();
    next.testsPending = false;
    if (command) next.lastTestCommand = command;
    return next;
  });
  console.log(`[OK]   已记录测试通过：${state.lastTestPassedAt}${command ? `（${command}）` : ''}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
