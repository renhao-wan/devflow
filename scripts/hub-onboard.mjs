#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  argValue, hasFlag, isMain, log, projectRoot, posix,
  warnUnknownArgs,
} from './lib/common.mjs';
import { generateOverview, OVERVIEW_FILE } from './lib/overview.mjs';

export function main(argv = process.argv.slice(2)) {
  warnUnknownArgs(argv, ['--root', '--print', '--json', '--now']);
  const root = resolve(argValue(argv, '--root', projectRoot()));
  const print = hasFlag(argv, '--print');
  const json = hasFlag(argv, '--json');
  if (print && json) throw new Error('--print 与 --json 不能同时使用');
  let isDir = false;
  try { isDir = existsSync(root) && statSync(root).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new Error(`工作区不存在或不是目录：${posix(root)}`);
  const nowRaw = argValue(argv, '--now', null);
  // --now 会直接写进自动段注释：只接受单行短字符串，避免注入额外 Markdown。
  if (nowRaw !== null && !/^[^\r\n]{1,80}$/.test(nowRaw)) {
    throw new Error('--now 需要单行文本（最多 80 字符）');
  }
  const now = nowRaw ?? new Date().toISOString();
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
  const summary = `${result.facts.techStack.length} 项技术栈、${result.subprojects.length} 个子项目、`
    + `${result.facts.entrypoints.length} 个入口、${result.facts.ci.length} 个 CI`;
  log(result.changed ? 'ok' : '..', result.changed
    ? `已更新 ${OVERVIEW_FILE}（${summary}）`
    : `${OVERVIEW_FILE} 无变化（${summary}）`);
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
