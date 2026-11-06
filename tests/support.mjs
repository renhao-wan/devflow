import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 测试进程统一指向临时个人库，绝不读写真实用户目录。
export const PERSONAL_LIB = mkdtempSync(join(tmpdir(), 'devflow-test-personal-'));
export const TEAM_LIB = mkdtempSync(join(tmpdir(), 'devflow-test-team-'));
export const CACHE_DIR = mkdtempSync(join(tmpdir(), 'devflow-test-cache-'));

process.env.DEVFLOW_PERSONAL_LIBRARY = PERSONAL_LIB;
process.env.DEVFLOW_TEAM_LIBRARY = TEAM_LIB;

// 不覆盖调用方显式传入的同名变量；默认隔离缓存并禁止 Git 交互式提示。
process.env.DEVFLOW_CACHE_DIR ??= CACHE_DIR;
process.env.GIT_TERMINAL_PROMPT ??= '0';
process.env.GCM_INTERACTIVE ??= 'never';

process.on('exit', () => {
  for (const dir of [PERSONAL_LIB, TEAM_LIB, CACHE_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结果。
    }
  }
});
