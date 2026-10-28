---
description: 回灌并提交：把项目改进写回插件模板，提交到分支并生成 PR 链接
argument-hint: --stage <stage> [--plugin-root <插件源码仓库>] [--base main] [--dry-run]
allowed-tools: Bash(node:*), Bash(git:*), Bash(gh:*), Read, Glob, Grep
---

执行 devflow 回灌并提交：**$ARGUMENTS**

前置条件：回灌目标必须是**插件源码仓库**（含 `.git`）。已安装的插件缓存只读，无法提交。

1. 必须包含 `--stage <req|plan|implement|test|review|debug>`；缺失时列出六个阶段并停止。
2. 先预览，不写文件、不建分支：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-ship.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS --dry-run
```

3. 向用户确认三件事：分支名、将提交的文件、版本变化。若提示“插件目录不是 git 仓库”，请用户改用
   `--plugin-root <插件源码仓库路径>` 重试。
4. 用户确认后去掉 `--dry-run` 执行。脚本会：
   - 复用 `hub-upstream --apply` 写入本地模板；
   - 创建 `devflow/upstream-<stage>-<时间戳>` 分支；
   - 只提交白名单文件（`templates/stages/`、`.claude-plugin/plugin.json`、`CHANGELOG.md`）；
   - 推送到 `origin`；
   - 有 `gh` 时自动创建 PR，否则输出 GitHub compare 链接。
5. 工作区里回灌无关的改动不会进入提交；脚本会提示哪些被跳过。
6. 如果 `git push` 失败，分支和提交会保留在本地，不要自动删除。

不要在用户未确认的情况下执行非 `--dry-run` 的提交与推送。
