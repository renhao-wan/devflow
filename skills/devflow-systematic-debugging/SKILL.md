---
name: devflow-systematic-debugging
description: Use when something fails, errors, or behaves unexpectedly. Enforces reproduce first, evidence over guesses, root cause before fix.
---

# 系统化排障

## 铁律

**不能复现，不修。** 没有证据的修改是赌博。

## 步骤

1. **复现**：最小命令/步骤，稳定触发。记录环境（版本、平台、配置）。
2. **读错误**：完整堆栈、第一处业务代码、错误码。不要只看最后一行。
3. **查已知问题（可选）**：用完整错误、错误码、依赖版本查官方 issue、变更日志与社区讨论；外部结论只作线索，必须本地复现验证。搜索失败时记录未验证项与盲区，不要把“没搜到”写成“没有已知问题”。
4. **缩小**：二分注释、最小样例、逐步还原输入。
5. **假设**：写成“如果 X 成立，应观察到 Y”，一次只验一个。
6. **实验**：最快验证方式，不改生产逻辑；实验可丢弃。
7. **修根因**：修触发条件背后的原因，不吞异常、不加重试掩盖。
8. **回归测试**：修复前失败、修复后通过。
9. **清理**：临时日志、调试代码、临时脚本全部删除。

## 常见错误做法

- 看到报错就加 try/catch。
- 加 sleep 或重试让测试“稳定”。
- 同时改多处，无法判断哪处生效。
- 修了症状（如把断言改松）没修原因。
- 在未复现时“猜着改”，然后说“应该好了”。
- 把外部 issue 的修复直接照搬，没确认版本、前提与本地是否一致。

## 记录

修复后写清四件事：现象、根因、修复、验证方式。根因不确定时明确写“未确认根因，仅规避”，并列出剩余风险。

## 与 superpowers 的关系

- 已安装 superpowers 时，排障技法可优先用其 `systematic-debugging`；本技能是未安装时的 fallback。
- 阶段顺序、产物路径与门禁以 devflow 为准；外部或 superpowers 的结论仍须本地复现验证。

## 与 devflow 阶段配合

- 在 debug 阶段使用；修复后回到 test 验证。轻量修复的普通小 bug 测试通过即结束，是否需要 review 以 `debug.md` 顶部 `review: required` 为准；完整任务与轻量功能在测试通过后进入 review。
- 需要并行调查时，使用 `devflow-debug-investigator` 子代理。
