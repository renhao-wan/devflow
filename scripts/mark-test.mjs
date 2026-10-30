#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText, writeAtomic, isMain, projectRoot, argValue } from './lib/common.mjs';

export async function main(argv = process.argv.slice(2)) {
  const root = argValue(argv, '--root', projectRoot());
  const command = argValue(argv, '--command', null);
  const file = join(root, '.claude', '.devflow-state.json');
  let state = {};
  if (existsSync(file)) {
    try { state = JSON.parse(readText(file)); } catch { state = {}; }
  }
  state.lastTestPassedAt = new Date().toISOString();
  state.testsPending = false;
  if (command) state.lastTestCommand = command;
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`[OK]   已记录测试通过：${state.lastTestPassedAt}${command ? `（${command}）` : ''}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  });
}
