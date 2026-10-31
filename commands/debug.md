---
description: 排障阶段：先复现再定位，验证根因后修复并补回归测试
argument-hint: <问题描述或报错信息>
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Bash(*)
---

执行 devflow 排障阶段：**$ARGUMENTS**

> 以下为入口摘要；与 `.claude/hub/stages/debug/SKILL.md` 冲突时，以 SKILL 为准。

1. 读取 `.claude/hub/stages/debug/SKILL.md`；方法可用 `devflow-systematic-debugging` 技能，需要并行验证假设时用 `devflow-debug-investigator` 子代理。
2. 先复现：拿到最小、稳定、可重复的命令或步骤。不能复现时说明缺什么，不要盲改。
3. 收集证据：完整错误、日志、相关输入、最近改动。
4. 需要时检索已知问题：用完整错误、错误码、依赖版本查官方 issue、变更日志与社区讨论；外部结论只作线索，必须本地复现验证。搜索失败时记录未验证项与盲区，不得把“没搜到”写成“没有已知问题”。
5. 缩小范围并提出假设，一次只验证一个；实验必须可丢弃。
6. 找到根因后再修复，不吞异常、不加无意义重试。
7. 补一个修复前失败、修复后通过的回归测试。
8. 清理临时日志与调试代码。
9. 报告：现象、根因、修复、验证方式；给出结论（`fixed` / `partial` / `unresolved`）；`partial` 或 `unresolved` 时必须写明未排除的风险与下一步；如做了外部检索，写明来源与本地验证结果。
