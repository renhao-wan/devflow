# 维护与运维

面向已经把 devflow 用起来的项目，说明插件升级、阶段模板回灌、提交 PR 与常见故障处理。安装与日常使用见根目录 [README](../README.md) 与 [usage.md](usage.md)。

## 回灌

回灌把项目里打磨过的规则送回插件模板。范围与出口是两个独立维度：

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| 范围 | `--stage <name>` | 单个阶段，`.claude/hub/stages/<name>/` → `templates/stages/<name>/` |
| 范围 | `--shared` | 共享规则，`.claude/hub/_shared/` → `templates/shared/` |
| 范围 | `--all` | 所有阶段；`_shared` 存在时一并回灌 |
| 出口 | `--to local`（默认） | 直接写入插件源码目录，不提交 |
| 出口 | `--to remote` | 在临时 worktree 中回灌、建分支、提交、推送并创建 PR（等价于 `/devflow:ship`） |

```bash
# 预览：显示分类与差异，不写文件
/devflow:upstream --stage plan

# 写入插件模板（默认不 bump 版本）
/devflow:upstream --stage plan --apply

# 同时升级版本并更新 CHANGELOG
/devflow:upstream --stage plan --apply --bump minor

# 回灌共享规则 / 回灌全部
/devflow:upstream --shared --apply
/devflow:upstream --all --apply

# 走远程 PR
/devflow:upstream --stage plan --to remote --apply

# 从 marketplace 安装时，运行时插件根在安装缓存里；需显式指定源码仓库
/devflow:upstream --stage plan --plugin-root D:/projects/devflow --apply
```

回灌目标必须是**插件源码仓库**。安装缓存（`~/.claude/plugins/cache/...`）会在升级时被覆盖，脚本会直接拒绝写入。若不想每次都传 `--plugin-root`，在项目根执行一次：

```bash
/devflow:init --source-root D:/projects/devflow
```

`--source-root` 会写入 `.devflow.json` 的 `pluginSourceRoot`，之后 `upstream` 与 `ship` 自动使用它；显式 `--plugin-root` 仍然优先。

### 显式分区标记

在规则文件里用注释块精确声明哪些内容属于通用、哪些属于项目：

```markdown
<!-- devflow:reusable -->
通用规则：先写验收标准，再给方案。
<!-- /devflow:reusable -->

<!-- devflow:local -->
本项目的网关在 10.0.3.14，仅内部可用。
<!-- /devflow:local -->
```

- `devflow:local` 块整块剔除，不会进入插件。
- `devflow:reusable` 块强制保留，但仍会做敏感扫描与提交前校验。
- 没有标记的内容按行扫描：命中敏感模式的行单独剔除，其余行照常回灌。剔除后若只剩 frontmatter 或空内容，整个文件判为项目专属。

敏感模式包括绝对路径（Windows 盘符、`/Users/<name>`、`/home/<name>`）、内网地址（`192.168.x.x` / `10.x.x.x` / `172.16.x.x`–`172.31.x.x` / `127.0.0.1` / `169.254.x.x`）、`.corp` / `.internal`、常见密钥格式（`sk-`、`ghp_`、`AKIA`、`Bearer`、URL 内 `user:pass@` 等），以及 `upstream.blocklist` 关键词与子项目名。子项目名按词边界匹配，`api` 不会误伤 `rapid` / `capital`；中文等非 ASCII 名称按普通包含处理。

### 写入与回滚

`--apply` 会：

1. 复制有变化的可回灌文件到 `templates/stages/<stage>/` 或 `templates/shared/`，保留相对路径；与插件一致的文件跳过；
2. 把被覆盖的旧文件备份到 `.devflow/backups/<id>/`，并写一份 journal，中断后重跑同一命令可续做；
3. 默认**不 bump** 版本；传 `--bump patch|minor|major` 时才同步更新 `.claude-plugin/plugin.json`、`package.json`、`.claude-plugin/marketplace.json` 的 `plugins[].version`（`metadata.version` 作为市场自身元数据一并更新），并写入 `CHANGELOG.md`；
4. 追加回灌日志到 `.devflow/upstream-log.jsonl` 与 `docs/upstream-log.md`。

回滚到某次回灌之前：

```bash
/devflow:upstream --revert <记录 ID>
```

记录 ID 在命令输出和 `docs/upstream-log.md` 中。回滚会恢复被覆盖的模板与版本文件，并删除该次新建的文件。

回灌会修改插件仓库，建议单独提交并在回灌后运行 `/devflow:doctor`。

## 升级插件

`/plugin update devflow` 之后，新版本会装到新的缓存目录，项目 `.devflow.json` 里记录的旧路径随即失效。项目里的阶段模板仍是旧版，需要同步：

```bash
# 预览：哪些会更新、哪些因手改而冲突
/devflow:sync --dry-run

# 执行：更新未改过的文件，跳过手改文件，然后重新生成投影
/devflow:sync
```

判定依据是 `.claude/.hub-sources.json`（schema v2）与 `.claude/.hub-bases/` 快照：账本为每个文件记录 `{ base, local }` 两个哈希，快照保存上次同步时的模板原文，作为三方合并的共同祖先。同步读取的是**当前安装的插件版本**，不会从 `pluginSourceRoot` 拉未发布模板。`stages/` 与 `_shared/` 都会同步。

| 情况 | 行为 |
| --- | --- |
| 本地文件与模板完全一致 | 记为一致，不重写 |
| 本地文件哈希与账本一致（未手改） | 更新为新模板 |
| 模板与基线一致、本地手改 | 保留手改，只刷新账本 |
| 本地与模板都改过，且有基线快照 | `git merge-file` 三方合并：无冲突则写入合并结果并报告「自动合并」 |
| 三方合并冲突 | 保留本地内容并报告冲突，手工合并后重跑 |
| `--force` | 跳过合并直接用模板覆盖，覆盖前生成 `.bak-<时间戳>` 备份 |
| 模板新增的资源文件 | 直接补入 |
| 模板已删除的文件 | 账本移除，本地保留（不删你的内容） |
| 本地缺少账本（老版本 init） | 一律按“可能手改”处理，只报告冲突 |

确认要用手改内容覆盖冲突文件时加 `--force`，覆盖前会在原文件旁生成 `.bak-<时间戳>` 备份。**不要用 `--force` 重跑 `init`**：那会覆盖 `hub.yaml`，而 `sync` 从不改 `hub.yaml` 与 `overrides/`。

自动合并后请检查合并结果再提交；重复运行 `sync` 是幂等的。

### 启用状态与重启

插件「装好」和「启用」是两件事，分别记录在两个文件里：

| 文件 | 内容 | 谁维护 |
| --- | --- | --- |
| `~/.claude/plugins/installed_plugins.json` | 安装记录：路径、版本、commit | 安装器与 `claude plugin update` |
| `~/.claude/settings.json` 的 `enabledPlugins` | 本会话是否加载该插件 | `/plugin` 界面或手动编辑 |

`claude plugin update` 只更新前者和缓存目录，**不会补写 `enabledPlugins`**。所以安装或升级后：

1. 确认 `enabledPlugins` 里有 `"devflow@devflow-marketplace": true`；
2. **重启 Claude Code 会话**，命令才会注册。

如果命令突然消失（例如 `/devflow:sync` 报 `Unknown command`），而插件缓存与 `installed_plugins.json` 都正常，先查 `enabledPlugins`。

> **注意**：用 cc-switch 等工具管理模型供应商配置时，切换供应商会用其数据库里的完整 `settings.json` 快照**整体覆盖**该文件。若快照生成于插件安装之前，`enabledPlugins` 里的 devflow 会被抹掉，表现为重启后命令不再存在。
>
> 只改 `~/.claude/settings.json` 只能撑到下次切换；要长期保留，需要把 `"devflow@devflow-marketplace": true` 加进 cc-switch 中每个供应商的配置快照。

## 提交与 PR

`/devflow:upstream --apply` 只写本地文件，不提交。要用 PR 的方式把回灌结果送出去，用 `/devflow:ship`，或 `/devflow:upstream --to remote`（两者共用同一套计划与提交逻辑）：

```bash
# 预览：显示分支名、将提交的文件、版本变化，不写文件
/devflow:ship --stage plan --plugin-root D:/projects/devflow --dry-run

# 执行：回灌 → 建分支 → 提交 → 推送 → 生成 PR（默认不 bump 版本）
/devflow:ship --stage plan --plugin-root D:/projects/devflow

# 显式升级版本
/devflow:ship --stage plan --plugin-root D:/projects/devflow --bump minor

# 多个范围一起回灌
/devflow:ship --stage plan --stage review --shared

# fork 工作流：推到自己的 fork，PR 开向 --pr-repo
/devflow:ship --stage plan --remote myfork --pr-repo owner/devflow

# 续推已有的回灌分支（例如上次 push 失败）
/devflow:ship --resume devflow/upstream-plan-20260101120000
```

回灌目标必须是**插件源码仓库**（含 `.git`）。已安装的插件缓存没有 git 历史，无法提 PR。

默认**不 bump 版本**，只更新模板与回灌日志；传 `--bump` 才升级三处版本号并写入 CHANGELOG。这样多次回灌可以先攒在一起，发布时统一升版。

PR 创建按优先级降级：

| 方式 | 条件 | 结果 |
| --- | --- | --- |
| `gh` CLI | 已安装并登录 | 创建或更新同 head 的 PR，返回链接 |
| GitHub API | 设置了 `GITHUB_TOKEN` 或 `GH_TOKEN` | 创建或更新同 head 的 PR，token 需有 `repo` 权限 |
| compare 链接 | 两者都没有 | 输出链接，在浏览器里点一次 |

同 head 分支已有开启中的 PR 时，`gh` 与 API 都会更新其标题与正文，不再重复创建。`--no-pr` 只推送分支。

安装 `gh`（Windows）：

```bash
winget install --id GitHub.cli
gh auth login --web
```

安全约束：

- 只提交白名单文件：`templates/stages/`、`templates/shared/`、`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`package.json`、`CHANGELOG.md`、`.devflow/upstream-log.jsonl`、`docs/upstream-log.md`。
- 这些文件在回灌前必须干净，否则脚本拒绝执行，避免把无关改动混进 PR。
- 工作区其他未提交改动不会进入提交，脚本会列出来。
- 提交前重新扫描写出的文件：仍含疑似密钥则停止；`SKILL.md` 的 frontmatter `name` 必须与目录名一致且 `description` 非空。
- 分支从 `--base`（默认 `main`）的本地分支或 `origin/<base>` 创建，不携带当前分支上的无关提交；使用 `origin/<base>` 时不会自动 fetch，远端刚更新过请先执行 `git fetch origin <base>`。
- 执行过程使用**临时 git worktree**：回灌、提交、推送都在临时目录完成，主工作区的当前分支与未提交改动不受影响，结束后自动清理。
- 分支名重名时自动加 `-2`、`-3` 后缀，同时检查本地与 `origin` 上的同名分支。
- `git push` 失败时保留本地分支和提交（不删除），主工作区不会切换；用 `--resume <分支>` 续推。
- 推送与错误信息会打码 URL 中的凭据和查询参数 token，避免泄露到终端或日志。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `找不到 devflow 插件目录` | 先运行 `/devflow:init`，或检查 `.devflow.json` 中的 `pluginRoot`；升级后旧缓存失效时，会优先使用当前会话的 `CLAUDE_PLUGIN_ROOT`，再回退到 `pluginSourceRoot` |
| `回灌目标落在安装缓存` | 插件是从 marketplace 安装的；用 `--plugin-root <插件源码仓库>`，或运行一次 `/devflow:init --source-root <插件源码仓库>` |
| `hub.yaml 解析失败` | 使用 YAML 子集：注释、嵌套 map、块列表、行内 `[a, b]`、标量；检查缩进与冒号 |
| 不知道当前做到哪一步 | 运行 `/devflow:status`；它只读推导阶段并给出下一步命令，不修改状态 |
| 投影漂移 / 手改提示 | 改源文件后运行 `node scripts/devflow-gen.mjs`，不要改投影 |
| 编辑投影/账本被拒绝 | `guard-generated` 阻止手改生成物；改 `.claude/hub/stages/` 后重新生成，或重跑 `/devflow:init` 刷新 loader |
| Stop 提示 hub 源改动未生成 | 运行 `node scripts/devflow-gen.mjs` 重新生成投影；之后提醒会自动消失 |
| 账本中有过期技能 | 运行 `node scripts/devflow-gen.mjs` 自动清理 |
| doctor 报阶段资源缺失 | 恢复资源文件，或重新生成；必要时从插件模板复制 |
| doctor 报测试命令依赖缺失 | `testCommand` 用到的工具不在 `PATH`；安装工具或修正命令 |
| doctor 报 `cd` 目录或本地脚本不存在 | `testCommand` 里的路径与实际目录不符；修正 `hub.yaml` 的 `testCommand` |
| `scripts/devflow-*.mjs` 不见了或内容过期 | loader 是生成物且被 `.gitignore` 忽略；重跑 `/devflow:init` 会重建并刷新旧 loader（`devflow-gen` 不负责生成 loader） |
| 生成器报阶段名非法 | `.claude/hub/stages/` 下的目录名必须以小写字母开头，只允许 `[a-z0-9_-]` |
| hooks 不生效 | 确认项目含 `.claude/hub/hub.yaml`；重启会话；确认 `node` 在 `PATH` |
| 插件已安装但命令报 `Unknown command` | `~/.claude/settings.json` 的 `enabledPlugins` 缺少 `"devflow@devflow-marketplace": true`；补上后重启会话。若使用 cc-switch，切换供应商会整体覆盖 `settings.json`，需把该启用项同步进各供应商快照 |
| 测试命令为空或错误 | 手动修改 `hub.yaml` 的 `testCommand`；root 无构建文件时默认写 `npm test`，必须替换 |
| 升级后模板还是旧的 | 运行 `/devflow:sync --dry-run` 查看是否有冲突；手改文件需确认后加 `--force` |
| 回灌后版本号没变 | 默认不 bump；需要发版时加 `--bump patch\|minor\|major` |
| 想撤销某次回灌 | `/devflow:upstream --revert <记录 ID>`；ID 见命令输出或 `docs/upstream-log.md` |
| 回灌后 `SKILL.md` 校验失败 | frontmatter `name` 必须与目录名一致，`description` 不能为空；修正后重新回灌 |
| 同步显示「自动合并」 | 本地与模板都改过，已按基线三方合并；检查结果后提交，冲突文件需手工合并 |
| 找不到回灌备份 | 备份在 `.devflow/backups/<记录 ID>/`；日志在 `.devflow/upstream-log.jsonl` 与 `docs/upstream-log.md` |
| 老项目没有新阶段资源 | 运行 `/devflow:sync` 补充模板新增的资源；`--force` 重跑 init 会覆盖 `hub.yaml`，不推荐 |
| 子项目识别错误 | 检查 `hub.yaml` 的 `subprojects`。含 `.git` 的容器目录会阻止下钻，深层项目需按 [usage.md](usage.md) 的“多根工作区”小节手动补充或改指向 |
| 工具路由总是 `use-devflow` | 运行 `devflow route --detect` 刷新检测；确认 `ecosystem.yaml` 的 `routing.mode` 不是 `off`，且工具已安装 |
| 检测结果过期 | doctor 会提醒；运行 `devflow route --detect` 更新 `.claude/.ecosystem-state.json` |
| 想临时不用其他工具 | 阶段命令加 `--force-devflow`，或把 `routing.forceDevflowStages` 加入该阶段；全局关闭用 `routing.mode: off` |
| route 报未知工具 | `--tool` 的值必须匹配 `.claude/hub/ecosystem.yaml` 的 `tools` 键；未知、禁用或阶段不匹配都会退出码 1 |
