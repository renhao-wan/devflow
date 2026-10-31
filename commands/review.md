---
description: 审查阶段：以缺陷为导向检查 diff，输出阻断项与建议项
argument-hint: [范围或 slug]
allowed-tools: Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Bash(git status:*), Bash(git diff:*), Bash(git log:*)
---

执行 devflow 审查阶段：**$ARGUMENTS**

1. 读取 `.claude/hub/stages/review/SKILL.md`。
2. 查看全量 diff（`git status`、`git diff`、必要时 `git diff --staged`），确认改动范围。
3. 读取 `docs/devflow/<slug>/req.md` 与 `plan.md`，逐条对照验收标准与任务清单：每条验收标准是否有实现或测试支撑，未覆盖项是否已明确接受。结果写入 review 的「验收对照」表。
4. 核对 `plan.md` 的「调研与复用判断」：来源是否可核对、许可证与 `req.md` 技术约束是否冲突、依赖维护状态与已知漏洞、搜索失败或未验证项是否已披露。结果写入「复用与依赖检查」表。
5. 按 SKILL 的顺序检查：正确性 → 安全 → 兼容 → 可维护 → 测试缺口 → 复用与依赖。
6. 需要独立视角时，调用 `devflow-code-reviewer` 子代理审查，再合并判断；子代理结论也要自己核实。
7. 每条问题给出 `文件:行号`、触发条件、建议；区分阻断项与建议项。
8. 结论写入 `docs/devflow/<slug>/review.md`（slug 未知时用 `latest`）。
9. 报告时先列阻断项；没有阻断项也要说明检查过哪些维度、验收标准的收敛结果与复用判断的核对结果。
