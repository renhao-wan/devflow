---
name: devflow-tdd
description: Use when implementing a feature or fixing a bug where behavior can be tested. Enforces failing test first, minimal implementation, then refactor.
---

# 测试驱动实现

## 循环

1. **红**：写一个最小测试，表达期望行为；运行，确认它因为正确的原因失败。
2. **绿**：写刚好让它通过的实现，不提前设计。
3. **重构**：在测试保持绿的前提下清理。

## 测试该写什么

优先覆盖：

- 正常路径：一条主流程。
- 边界：空、0、最大、重复、超长。
- 错误路径：非法输入、依赖失败、超时。
- 回归：每个修过的 bug 补一条。

不写：

- 只断言 getter/setter 的测试。
- 依赖实现细节、改一行就碎的测试。
- 需要真实网络的单元测试（改为集成测试或注入替身）。

## 断言质量

- 断言结果，不断言调用次数（除非顺序本身是契约）。
- 错误路径要断言错误类型或消息的关键部分，不只断言“抛错了”。
- 一个测试只验证一个行为；名字写清“在什么条件下得到什么结果”。

## 确认失败原因

测试失败时先看失败信息：

- 断言失败 → 行为未实现，正常。
- 编译/导入失败 → 测试本身有问题，先修测试。
- 环境失败 → 先解决环境，不要改断言。

## 与 superpowers 的关系

- 已安装 superpowers 时，TDD 的执行技法可优先用其 `test-driven-development`；本技能是未安装时的 fallback。
- 阶段顺序、产物路径与门禁以 devflow 为准；两者结论冲突时不动摇 devflow 的门禁。

## 与 devflow 阶段配合

- 在 implement 阶段使用。
- test 阶段负责全量与覆盖记录。
- debug 阶段修复前先补一条会失败的回归测试。
