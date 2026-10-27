---
description: 审查阶段：以缺陷为导向检查 diff，输出阻断项与建议项
argument-hint: [范围或 slug]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git status:*), Bash(git diff:*), Bash(git log:*)
---

执行 devflow 审查阶段：**$ARGUMENTS**

1. 读取 `.claude/hub/stages/review/SKILL.md`。
2. 查看全量 diff（`git status`、`git diff`、必要时 `git diff --staged`），确认改动范围。
3. 按 SKILL 的顺序检查：正确性 → 安全 → 兼容 → 可维护 → 测试缺口。
4. 需要独立视角时，调用 `devflow-code-reviewer` 子代理审查，再合并判断；子代理结论也要自己核实。
5. 每条问题给出 `文件:行号`、触发条件、建议；区分阻断项与建议项。
6. 结论写入 `docs/devflow/<slug>/review.md`（slug 未知时用 `latest`）。
7. 报告时先列阻断项；没有阻断项也要说明检查过哪些维度。
