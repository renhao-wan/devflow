// 钩子共用：读 stdin、定位 hub 根。钩子必须永远不抛，调用方自行 try/catch。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
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
