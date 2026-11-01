// 钩子共用：读 stdin、定位 hub 根。钩子必须永远不抛，调用方自行 try/catch。
import { existsSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const STDIN_TIMEOUT_MS = Number(process.env.DEVFLOW_STDIN_TIMEOUT_MS) || 3000;

/** 返回 { text, complete }：超时截断时 complete=false，调用方不能把半截数据当成完整输入。 */
export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (complete) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ text: data, complete });
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => finish(true));
    process.stdin.on('error', () => finish(false));
    const timer = setTimeout(() => finish(false), STDIN_TIMEOUT_MS);
  });
}

/** 写入 JSON 状态：临时文件名带进程与随机后缀，避免并发钩子互相覆盖。 */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export function findHubRoot(start) {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.claude', 'hub', 'hub.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
