// 钩子共用：读 stdin、定位 hub 根、串行化状态读写。钩子必须永远不抛，调用方自行 try/catch。
import { existsSync, writeFileSync, renameSync, rmSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const STDIN_TIMEOUT_MS = Number(process.env.DEVFLOW_STDIN_TIMEOUT_MS) || 3000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

/** 独占锁文件；残留锁按 staleMs 回收，等待超时后降级无锁，钩子不能卡住编辑。 */
function withLock(file, fn, { timeoutMs = 1000, staleMs = 5000 } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (true) {
    try {
      mkdirSync(dirname(lock), { recursive: true });
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch { /* 锁刚被释放 */ }
      if (Date.now() >= deadline) break;
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try { rmSync(lock, { force: true }); } catch { /* ignore */ }
    }
  }
}

/** 锁内读取-修改-写回状态；返回 mutate 的结果。 */
export function updateState(file, mutate) {
  return withLock(file, () => {
    let state = {};
    if (existsSync(file)) {
      try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = {}; }
    }
    const next = mutate(state) || state;
    writeJsonAtomic(file, next);
    return next;
  });
}
