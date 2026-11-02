---
name: ship
description: 远程回灌：把项目改进写回插件模板，提交到分支并创建或更新 PR
argument-hint: --stage <stage> | --shared | --all [--plugin-root <插件源码仓库>] [--base main] [--bump patch|minor|major] [--remote <name>] [--fork] [--pr-repo <owner/repo>] [--resume <branch>] [--no-pr] [--dry-run]
allowed-tools: Bash(node:*), Bash(git:*), Bash(gh:*), Read, Glob, Grep
disable-model-invocation: true
---

执行 devflow 远程回灌：**$ARGUMENTS**

前置条件：回灌目标必须是**插件源码仓库**（含 `.git`）。已安装的插件缓存只读，无法提交。

1. 回灌范围三选一：`--stage <req|plan|implement|test|review|debug>`、`--shared` 或 `--all`；使用 `--resume <branch>` 续做时可不填。
2. 先预览，不写文件、不建分支：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/hub-ship.mjs" --root "${CLAUDE_PROJECT_DIR:-.}" $ARGUMENTS --dry-run
```

3. 向用户确认：分支名、将提交的文件、版本变化、推送远端与 PR head。若提示“插件目录不是 git 仓库”，请用户改用 `--plugin-root <插件源码仓库路径>` 重试。
4. 用户确认后去掉 `--dry-run` 执行。脚本会：
   - 在临时 worktree 中按行剔除敏感内容后写入模板；
   - 创建 `devflow/upstream-<范围>-<时间戳>` 分支；
   - 只提交白名单文件（`templates/stages/`、`templates/shared/`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json`、`CHANGELOG.md`、`.devflow/upstream-log.jsonl`、`docs/upstream-log.md`）；
   - 校验写出的 `SKILL.md` frontmatter 与二次密钥扫描，不通过则停止；
   - 推送到 `--remote`（默认 `origin`）；
   - 有 `gh` 时自动创建 PR，已存在同名 head 的 PR 则更新标题与正文；否则走 GitHub API；两者都没有时输出 compare 链接。
5. 远程回灌**默认不 bump 版本**；只有显式 `--bump patch|minor|major` 才升级并更新 CHANGELOG。
6. fork 场景：用 `--remote <fork 远端名>` 推送，`--fork` + `--pr-repo <上游 owner/repo>` 指定 PR 目标；head 会自动带上 fork owner。
7. 工作区里回灌无关的改动不会进入提交；脚本会提示哪些被跳过。
8. 如果 `git push` 失败，分支和提交会保留在本地，不要自动删除；可在修复后用 `--resume <branch>` 续推。

不要在用户未确认的情况下执行非 `--dry-run` 的提交与推送。
