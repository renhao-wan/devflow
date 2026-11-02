---
name: upstream
description: 回灌：把项目里改进过的阶段/共享规则回馈到插件（默认只预览，可回灌本地或远程）
argument-hint: --stage <stage> | --shared | --all [--to local|remote] [--apply] [--bump patch|minor|major|--no-bump] [--plugin-root <插件源码仓库>]
allowed-tools: Bash(node:*), Bash(git diff:*), Read, Glob, Grep, Write, Edit
disable-model-invocation: true
---

执行 devflow 回灌：**$ARGUMENTS**

1. 回灌范围三选一：`--stage <req|plan|implement|test|review|debug>`、`--shared`（共享规则）或 `--all`。缺失时列出选择并停止。
2. 两种出口由 `--to` 决定：
   - `local`（默认）：写入插件源码仓库的 `templates/`，不提交。
   - `remote`：委托 `hub-ship` 建分支、提交、推送并创建/更新 PR；不带 `--apply` 时等价于 dry-run。
3. 默认先预览（不加 `--apply`）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-upstream.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS
```

4. 向用户解释分类结果：
   - `[可回灌]`：通用内容。命中敏感行时只剔除对应行，其余内容仍可回灌。
   - `[项目专属]`：位于 `<!-- devflow:local -->` 块内，或剔除后没有正文，不会回灌。
   - `<!-- devflow:reusable -->` 块一定会保留，但仍会做敏感扫描。
5. 只有用户明确同意后才追加 `--apply`。本地回灌默认 bump `patch`；`--bump minor|major` 调整幅度，`--no-bump` 保持不变。
6. 回灌后可用的后续动作：
   - 回滚本次写入：`--revert <记录 ID>`（ID 在回灌输出里）；
   - 同步到项目：`/devflow:sync`；
   - 验证：`/devflow:doctor`；
   - 送远程：`--to remote --apply` 或 `/devflow:ship`。
7. 如果提示“回灌目标落在安装缓存”，说明当前插件是从 marketplace 安装的：让用户改用 `--plugin-root <插件源码仓库>`，或先运行 `/devflow:init --source-root <插件源码仓库>` 记录一次。
8. 不要回灌包含密钥、内网地址、公司内部信息的内容；发现时直接停下并告知用户。
