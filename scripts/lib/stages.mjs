import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 显式数组按声明使用：空数组表示不启用任何阶段。
 * 字段缺失或留空（null）时回退扫描 `.claude/hub/stages/`；其他类型属于配置错误，由调用方统一报告。
 * 生成器与 doctor 共用同一视图，避免两处判断不一致。
 */
export function resolveStages(config = {}, root) {
  const declared = config?.stages;
  if (Array.isArray(declared)) return { stages: declared.map(String), error: null };
  if (declared != null) return { stages: [], error: 'hub.yaml 的 stages 必须是列表。' };

  const dir = join(root, '.claude', 'hub', 'stages');
  if (!existsSync(dir)) return { stages: [], error: null };
  return {
    stages: readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    error: null,
  };
}
