---
name: init
description: 在项目中初始化 devflow：生成 .claude/hub、薄 loader、投影技能，并探测子项目
argument-hint: [--force] [--plugin-root <插件目录>] [--source-root <插件源码仓库>]
allowed-tools: Bash(node:*), Read, Write, Edit, Glob, Grep
disable-model-invocation: true
---

初始化当前项目为 devflow 工作区。项目根为 `$CLAUDE_PROJECT_DIR`（未设置时用当前目录）。

1. 运行：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-init.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

2. 如果已初始化（提示 hub.yaml 已存在），不要加 `--force` 覆盖；先运行 `/devflow:doctor` 说明现状。
3. 初始化后读取 `.claude/hub/hub.yaml`，向用户展示：
   - 自动探测到的子项目与各自阶段
   - 默认测试命令
   - 需要用户确认或修改的地方（尤其测试命令为空、子项目识别错误）
4. 告诉用户下一步：编辑 `hub.yaml` 与 `.claude/hub/stages/*/SKILL.md`，然后运行 `node scripts/devflow-gen.mjs`。
5. 从 marketplace 安装时，插件根位于安装缓存；若要回灌，提醒用户用 `/devflow:init --source-root <插件源码仓库>` 记录一次，否则每次都要传 `--plugin-root`。
6. 插件升级后，用 `/devflow:sync` 同步模板，不要用 `--force` 重跑 init。
7. 不要修改项目业务代码。
