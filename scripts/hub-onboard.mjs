#!/usr/bin/env node
import { resolve, join } from 'node:path';
import {
  argValue, hasFlag, isMain, log, projectRoot, posix,
} from './lib/common.mjs';
import { generateOverview, OVERVIEW_FILE } from './lib/overview.mjs';

export function main(argv = process.argv.slice(2)) {
  const root = resolve(argValue(argv, '--root', projectRoot()));
  const print = hasFlag(argv, '--print');
  const json = hasFlag(argv, '--json');
  const now = argValue(argv, '--now', new Date().toISOString());
  const result = generateOverview(root, { full: true, now, write: !print });

  if (print) {
    console.log(result.content);
    return result;
  }
  if (json) {
    console.log(JSON.stringify({
      file: posix(join(root, OVERVIEW_FILE)),
      changed: result.changed,
      subprojects: result.subprojects,
      facts: result.facts,
    }, null, 2));
    return result;
  }
  log(result.changed ? 'ok' : '..', result.changed
    ? `已更新 ${OVERVIEW_FILE}`
    : `${OVERVIEW_FILE} 无变化`);
  return result;
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    process.exit(1);
  }
}
