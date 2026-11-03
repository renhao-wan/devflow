import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 测试进程统一指向临时个人库，绝不读写真实用户目录。
export const PERSONAL_LIB = mkdtempSync(join(tmpdir(), 'devflow-test-personal-'));
export const TEAM_LIB = mkdtempSync(join(tmpdir(), 'devflow-test-team-'));

process.env.DEVFLOW_PERSONAL_LIBRARY = PERSONAL_LIB;
process.env.DEVFLOW_TEAM_LIBRARY = TEAM_LIB;

process.on('exit', () => {
  for (const dir of [PERSONAL_LIB, TEAM_LIB]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结果。
    }
  }
});
