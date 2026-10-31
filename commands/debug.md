---
description: 排障阶段：先复现再定位，验证根因后修复并补回归测试
argument-hint: <问题描述或报错信息>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(*)
---

执行 devflow 排障阶段：**$ARGUMENTS**

1. 读取 `.claude/hub/stages/debug/SKILL.md`。
2. 先复现：拿到最小、稳定、可重复的命令或步骤。不能复现时说明缺什么，不要盲改。
3. 收集证据：完整错误、日志、相关输入、最近改动。
4. 缩小范围并提出假设，一次只验证一个；实验必须可丢弃。
5. 找到根因后再修复，不吞异常、不加无意义重试。
6. 补一个修复前失败、修复后通过的回归测试。
7. 清理临时日志与调试代码。
8. 报告：现象、根因、修复、验证方式；给出结论（`fixed` / `partial` / `unresolved`）；`partial` 或 `unresolved` 时必须写明未排除的风险与下一步。
