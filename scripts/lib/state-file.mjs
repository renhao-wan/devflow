// .devflow-state.json 的共享读取与过期提示确认（status --ack）写入。
// status 默认只读；只有 --ack 会调用这里的写入函数。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPathInside, isRealPathInside, readText, updateJson } from './common.mjs';
import { staleKey } from './artifact-chain.mjs';

export function stateFileOf(root) {
  return join(root, '.claude', '.devflow-state.json');
}

/** 手改或写入中断可能留下 null / 数组，按空状态处理，避免读取属性时崩溃。 */
export function readStateFile(root) {
  const file = stateFileOf(root);
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readText(file));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** 取某个任务的过期确认记录；形状不合法时视为未确认。 */
export function ackOf(state, slug) {
  const acks = state?.staleAcks;
  if (!acks || typeof acks !== 'object' || Array.isArray(acks)) return null;
  const ack = acks[slug];
  return ack && typeof ack === 'object' && !Array.isArray(ack) ? ack : null;
}

/**
 * 指纹包含每一对过期关系的上游/下游 mtime：
 * 任一产物增删或再次写入都会改变 key，确认自动失效。
 */
export function isStaleAcked(entries = [], ack = null) {
  if (!entries.length || !ack) return false;
  if (typeof ack.key !== 'string' || !ack.key) return false;
  return ack.key === staleKey(entries);
}

export function writeStaleAck(root, slug, entries = [], { from = null, at = new Date() } = {}) {
  if (!entries.length) return null;
  const file = stateFileOf(root);
  // 状态文件与 .claude 目录都可能被 junction/符号链接替换，写入前必须确认仍在项目内。
  if (!isPathInside(root, file) || !isRealPathInside(root, file)) {
    throw new Error(`拒绝写入项目外的状态文件：${file}`);
  }
  const ack = {
    key: staleKey(entries),
    from,
    at: at.toISOString(),
  };
  updateJson(file, (current) => {
    const next = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const acks = next.staleAcks && typeof next.staleAcks === 'object' && !Array.isArray(next.staleAcks)
      ? next.staleAcks
      : {};
    return { ...next, staleAcks: { ...acks, [slug]: ack } };
  });
  return ack;
}
