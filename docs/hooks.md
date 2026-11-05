# 安全门禁与 hooks

devflow 通过 Claude Code hooks 提供尽力而为的安全门禁与状态提醒。hooks 异常时一律放行（fail-open），不会把正常操作挡死；修改 hooks 或插件后需要重启会话。

## 作用域

`guard-dangerous` 在安装插件后对所有项目的 shell 类工具（`Bash`、`PowerShell`、`Monitor`）生效；`guard-generated` 只在包含 `.claude/hub/hub.yaml` 的工作区生效；`track-changes`、`prompt-reminder`、`check-tests`、`load-hub` 也只在 hub 工作区生效，不会向其他项目写入状态；`subagent-note` 在任意项目使用 devflow 子代理时向主上下文注入核对提醒并显示给用户，不写状态。

| 事件 | 脚本 | 行为 |
| --- | --- | --- |
| `PreToolUse(Bash/PowerShell/Monitor)` | `guard-dangerous.mjs` | 危险命令 `deny` 或 `ask` |
| `PreToolUse(Edit/Write/MultiEdit/NotebookEdit)` | `guard-generated.mjs` | 阻止手改投影、账本（含 `.claude/.devflow-state.json`）与 loader |
| `PostToolUse(Edit/Write/MultiEdit/NotebookEdit/Bash/PowerShell/Monitor)` | `track-changes.mjs` | 记录改动文件；hub 源改动单独标记 |
| `UserPromptSubmit` | `prompt-reminder.mjs` | 有未验证改动时注入一次提醒，从不阻止 |
| `PostToolUse(Agent/Task)` | `subagent-note.mjs` | devflow 子代理结束后向主上下文注入核对提醒，同时显示给用户，从不阻止 |
| `Stop` | `check-tests.mjs` | 有改动但未验证通过、或 hub 源改动未重新生成时提醒，从不阻止 |
| `SessionStart` | `load-hub.mjs` | 注入阶段、子项目与投影漂移摘要 |

## 生成物写保护

以下文件由插件脚本维护，直接编辑会与账本漂移，`guard-generated` 会拒绝这类写入：

- `.claude/skills/devflow-*/SKILL.md`（阶段投影，新增/删除规则文件或修改 `hub.yaml` 后运行 `node scripts/devflow-gen.mjs`；只改已有正文不需要）；
- `.claude/.hub-manifest.json`、`.claude/.hub-sources.json`（生成账本）；
- `.devflow.json`（init 写入的工作区元数据）；
- `scripts/devflow-gen.mjs`、`scripts/devflow-doctor.mjs`、`scripts/devflow-route.mjs`、`scripts/devflow-upstream.mjs`、`scripts/devflow-test.mjs`、`scripts/devflow-triage.mjs`、`scripts/devflow-check.mjs`、`scripts/devflow-trace.mjs`（loader，重跑 `/devflow:init` 刷新）。

`docs/devflow/**` 与 `.claude/hub/**` 的改动被视为流程数据而非业务代码：前者不计入待验证改动，后者会在 Stop 时提示生成或体检（改正文可只跑 `doctor`），但都不会阻止 Stop。

## 直接拒绝（deny）

系统级或不可恢复的破坏，例如：

- `rm -rf /`、`rm -rf ~`、`rm -rf *`（含 `rm -fr *`、`rm -r -f *`、`rm --recursive --force *` 等选项乱序或长选项写法）；
- `mkfs`、`fdisk`、`dd of=/dev/sda`；
- `curl ... | bash`、`wget ... | sh`；
- 强推 `main` / `master` / `release/*`，以及 `git push origin +main`、`git push origin :main` 这类等价的强推/删远端分支写法；
- `DROP DATABASE`、`TRUNCATE TABLE`；
- Windows 下递归删除盘符根（`rd /s /q C:\`、`del /s C:\*`）、`diskpart`、`cipher /w`、`vssadmin delete shadows`、`Format-Volume`；
- `shutdown`、`reboot`。

## 要求确认（ask）

常见但可能丢数据的操作，例如：

- `git push --force`（非保护分支）、`git reset --hard`、`git clean -fdx` / `git clean --force`；
- `git checkout .`、`git restore .`、`git branch -D` / `git branch --delete --force`；
- `git update-ref -d`、`git filter-branch`、`git push --mirror`、`git reflog expire`；
- 删除远端分支（`git push origin :feature`）、`npm publish`；
- `docker rm -f`、`docker system prune`、`kubectl delete`、`helm uninstall`；
- 删除数据库列、回滚迁移；
- `rm -rf <路径>`（含 `rm -fr <路径>`、`rm --recursive --force <路径>`）；
- Windows 下非盘符根的递归删除（`rd /s`、`del /s`、`Remove-Item -Recurse`）。

## 拦截边界

> `guard-dangerous` 是**基于正则的尽力拦截**，不是安全沙箱：引号包裹、变量展开、`--no-preserve-root`、`/bin/rm` 等写法可能绕过。它的作用是减少误操作，不能替代权限控制与备份。

hooks 只做提醒或拦截，不改变阶段门禁与产物路径；原生 `/goal`、子代理等能力的接入与降级见 [native-capabilities.md](native-capabilities.md)。
