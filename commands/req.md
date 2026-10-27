---
description: 需求阶段：澄清目标、验收标准与边界，产出 req.md
argument-hint: <需求描述或 slug>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ls:*), Bash(git status:*), Bash(node:*)
---

对以下诉求执行 devflow 需求阶段：**$ARGUMENTS**

1. 读取 `.claude/hub/stages/req/SKILL.md`；文件不存在时提示先运行 `/devflow:init`，然后停止。
2. 读取 `.claude/hub/hub.yaml` 了解子项目与阶段划分。
3. 按 SKILL 中的执行步骤工作：
   - 先复述目标，再只问阻塞性问题（一次最多 3 个）。
   - 能通过读代码确认的事实，先读代码，不反问用户。
4. 严格遵守 SKILL 中的门禁，逐条自查；不满足就继续澄清，不进入方案。
5. 产出写入 `docs/devflow/<slug>/req.md`。slug 使用 kebab-case，从需求内容提炼；目录不存在时创建。
6. 最后用一段话报告：目标、验收标准数量、本次不做的项、影响面、遗留待确认项。
