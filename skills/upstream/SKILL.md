---
name: upstream
description: 回灌：把项目里改进过的阶段、共享与技术栈规则回馈到个人库、团队库或上游插件（默认只预览）
argument-hint: --stage <stage> | --stack <name> | --shared | --all [--to personal|team|upstream] [--pr] [--apply] [--revert <id>] [--force] [--plugin-root <插件源码仓库>] [--personal-library <path>] [--team-library <path>]
allowed-tools: Bash(node:*), Bash(git diff:*), Read, Glob, Grep, Write, Edit
disable-model-invocation: true
---

执行 devflow 回灌：**$ARGUMENTS**

1. 回灌范围四选一：`--stage <req|plan|implement|test|review|debug>`、`--stack <name>`（技术栈规范）、`--shared`（共享规则）或 `--all`（全部阶段与技术栈）。缺失时列出选择并停止。
2. 目标库由 `--to` 决定（默认 `upstream`）：
   - `personal`：写入个人库（默认 `~/.claude/devflow`），供自己其他项目复用；直接写本地，不提交。
   - `team`：写入 `hub.yaml` 配置的团队库；默认只写工作区，不提交。加 `--pr` 才建分支、提交、推送并创建/更新 PR。
   - `upstream`：写入插件源码仓库的 `templates/`，不提交。加 `--pr` 才建分支、提交、推送并创建/更新 PR。
   - `personal` 不支持 `--pr`；三个库的回灌都不改版本文件。
3. 默认先预览（不加 `--apply`）。预览命令中必须去掉用户参数里的 `--apply`，否则预览会直接写入目标库：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-upstream.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" <用户参数，去掉 --apply>
```

   - `--revert <记录 ID>` 是独立的写入操作，不接受预览：不要把它拼进预览命令；只有用户明确要求回滚、并确认记录 ID 与目标库后才执行 `--to <库> --revert <记录 ID>`。
   - `--pr` 只在 `--apply` 时真正创建 PR；单独出现时随预览一起展示将要提交的范围。

4. 向用户解释分类结果：
   - `[可回灌]`：通用内容。命中敏感行时只剔除对应行，其余内容仍可回灌。
   - `[项目专属]`：位于 `<!-- devflow:local -->` 块内，或剔除后没有正文，不会回灌。
   - `<!-- devflow:reusable -->` 块一定会保留，但仍会做敏感扫描。
5. 只有用户明确同意后才在预览命令上追加 `--apply`；确认执行命令中不含 `--revert`。回灌只写模板与回灌日志，不改版本文件；发版由维护者另行处理。个人库与团队库写入后由用户自行提交（团队库 `--pr` 例外）。
6. 回灌后可用的后续动作：
   - 回滚本次写入：`--to <库> --revert <记录 ID>`；未指定 `--to` 时依次在个人、团队、上游日志中查找；
   - 同步到项目：`/devflow:sync`；
   - 验证：`/devflow:doctor`；
   - 送远程：团队库用 `--to team --pr --apply`；上游用 `--to upstream --pr --apply` 或 `/devflow:ship`。
7. 团队库提示：
   - 路径不存在时，按报错里的 `git clone <repo> <path>` 操作，或用 `--team-library <path>` / `.devflow.json` 的 `teamLibraryPath` 指向本机已有 clone；
   - 团队库必须是 git 仓库顶层；
   - 目标文件已有未提交改动会拒绝写入，先提交或 stash；确认放弃时加 `--force`（先备份再覆盖）。
8. 如果提示“回灌目标落在安装缓存”，说明当前插件是从 marketplace 安装的：让用户改用 `--plugin-root <插件源码仓库>`，或先运行 `/devflow:init --source-root <插件源码仓库>` 记录一次。
9. 不要回灌包含密钥、内网地址、公司内部信息的内容；发现时直接停下并告知用户。
