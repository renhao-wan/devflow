---
name: init
description: 在项目中初始化 devflow：生成 .claude/hub、薄 loader、投影技能，并探测子项目
argument-hint: [--force] [--draft] [--no-draft] [--plugin-root <插件目录>] [--source-root <插件源码仓库>] [--personal-library <个人库路径>] [--team-library <团队库路径>]
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Grep, AskUserQuestion
disable-model-invocation: true
---

初始化当前项目为 devflow 工作区。项目根为 `$CLAUDE_PROJECT_DIR`（未设置时用当前目录）。

1. 运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-init.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

2. 如果已初始化（提示 hub.yaml 已存在），不要加 `--force` 覆盖；先运行 `/devflow:doctor` 说明现状。重复运行 init 只会补生成缺失的通用草稿，不覆盖已有草稿。
3. 初始化后读取 `.claude/hub/hub.yaml`，向用户展示：
   - 自动探测到的子项目与各自阶段
   - 默认测试命令
   - 是否自动写入了 `stack`（只探测到单一技术栈时才会写）
   - 需要用户确认或修改的地方（尤其测试命令为空、子项目识别错误）
4. 读取 init 生成的规则草稿（首行为 `<!-- devflow:draft -->`）：
   - `.claude/hub/_shared/project-basics.md`
   - 单一技术栈时的 `.claude/hub/stacks/<stack>/_shared.md`

   告诉用户草稿里的 `TODO:` 是占位，不是规则；草稿标记删除前不会进入投影、同步与回灌。阶段入口 `stages/<stage>/SKILL.md` 不能标记为草稿。使用 `--no-draft` 时没有草稿，跳过本步。
   **只有 `$ARGUMENTS` 显式包含 `--draft` 时才执行第 5 步补全；默认只生成草稿，不做智能补全。**
5. `--draft` 智能补全草稿：先读 `.claude/hub/project-overview.md`（存在时），否则用 `Read`、`Glob`、`Grep` 查看 README、构建文件与目录结构，把能从项目确认的内容替换掉对应 `TODO:`。无法确认的最多问 3 个问题（用 `AskUserQuestion`）；问完仍不确定的保留 `TODO:`，不要编造版本号、命令或团队约定。未传 `--draft` 时跳过本步，并告诉用户之后可用 `/devflow:init --draft` 补全。
6. 用户确认后，删除每个已填写草稿首行的 `<!-- devflow:draft -->`。只删除用户确认过的；用户暂时不想写的草稿保留标记。
7. 若本次补全了草稿或删除了草稿标记，运行 `node scripts/devflow-gen.mjs`，再运行 `node scripts/devflow-doctor.mjs` 确认没有错误。没有改动草稿时 gen / doctor 都是可选的，只在用户需要时运行。
8. 告诉用户下一步优先用 `/devflow:req <需求>` 开始六阶段流程。需要时再补充 `.claude/hub/stages/*/SKILL.md` 的阶段规范；后续新增规则不确定放哪时使用 `devflow-rule-placement`；可运行 `/devflow:onboard` 生成更完整的项目概览。
9. 从 marketplace 安装时，插件根位于安装缓存；若要回灌，提醒用户用 `/devflow:init --source-root <插件源码仓库>` 记录一次，否则每次都要传 `--plugin-root`。
10. 团队库与个人库的本机路径可用 `--team-library` / `--personal-library` 指定一次，init 会写入 `.devflow.json`，后续 `sync` / `upstream` 直接复用；团队库仍需在 `hub.yaml` 的 `templates.team` 中启用。
11. 插件升级后，用 `/devflow:sync` 同步模板，不要用 `--force` 重跑 init。
12. 不要修改项目业务代码。
