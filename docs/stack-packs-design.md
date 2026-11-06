# 技术栈包（stack packs）设计

面向维护者与实现者。目标是让官方或团队在独立仓库维护技术栈规范，项目按需安装单个栈到 `.claude/hub/stacks/<stack>/`，并支持离线、可复现、可更新、可回滚。

本文只定义设计与边界，不包含实现步骤。命令行为以本文为准；实现拆分见文末顺序。

## 1. 背景

devflow 目前不带任何技术栈规范：`templates/stacks/` 为空，`init` 只会在探测到单一技术栈时生成一份 `_shared.md` 草稿。用户要么自己写，要么从别的项目复制。

现有模板库机制不能直接解决这个问题：

- `collectTemplateFiles()` 会遍历模板库的整个 `templates/stacks/`，把全部栈复制进项目。官方预置多个栈会污染每个项目。
- 团队库只读本机已 clone 的路径，`templates.team.repo` 只用于提示，不会自动拉取。
- `sync` 的语义是“库 → 项目”的合并，不是“按需安装单个包”。

因此需要一个独立来源、独立命令、独立账本的安装机制。安装结果必须是普通栈目录，`gen`、投影、`planStacks`、hooks 都不需要知道包的存在。

## 2. 目标与非目标

目标：

- 从独立 git 仓库按需安装单个技术栈。
- 安装结果就是普通 `.claude/hub/stacks/<stack>/` 文件。
- 离线可用、按 commit 可复现、可更新、可回滚。
- 与现有模板库、`sync`、`upstream`、`doctor` 有明确边界。
- 包内容按不可信输入处理，校验失败即拒绝。

非目标（v1 不做）：

- 官方默认源常量和自动推荐安装。
- 把来源写回 `hub.yaml`。
- 包之间的依赖或组合安装。
- 从远程直接执行脚本、安装器或任意文件类型。
- 多包版本求解器。
- 自动清理全局缓存。

## 3. 不变量

1. 一个栈目录只能有一个 owner：pack、模板库或用户手写，三者互斥。
2. 本地账本决定本机所有权；lock 决定跨机器复现；`hub.yaml` 继续保持手工维护。
3. 安装、更新、删除都不改写 `hub.yaml`。
4. 任何包文件都必须先通过格式、路径、哈希、大小与兼容性校验，才可能写入项目。
5. 事务失败不能留下“目录、账本、bases 三者不一致”的半提交状态。
6. `--force` 只覆盖本机目标目录，不跳过任何校验。

## 4. 仓库格式

```
devflow-stacks/
├─ index.json
└─ stacks/
   ├─ java-spring/
   │  ├─ stack.json
   │  ├─ _shared.md
   │  ├─ req.md
   │  ├─ plan.md
   │  ├─ implement.md
   │  ├─ test.md
   │  ├─ review.md
   │  └─ references/
   │     └─ ...
   └─ vue3/
      ├─ stack.json
      └─ ...
```

`index.json` 是索引，不需要检出全部内容：

```json
{
  "schemaVersion": 1,
  "packs": {
    "java-spring": {
      "title": "Spring Boot / Maven",
      "description": "Java 后端阶段规范",
      "path": "stacks/java-spring",
      "detects": ["java-maven", "java-gradle"],
      "tags": ["java", "spring", "backend"]
    },
    "vue3": {
      "title": "Vue 3 + TypeScript",
      "path": "stacks/vue3",
      "detects": ["nodejs"],
      "tags": ["frontend", "vue"]
    }
  }
}
```

`stack.json`：

```json
{
  "name": "java-spring",
  "title": "Spring Boot / Maven",
  "version": "1.2.0",
  "minDevflow": ">=1.8.0",
  "detects": ["java-maven", "java-gradle"],
  "files": {
    "_shared.md": "<contentHash hex>",
    "plan.md": "<contentHash hex>"
  }
}
```

约束：

- 包内只允许 `stack.json`、`.md` 与 `references/**/*.md`。
- `files` 必须覆盖除 `stack.json` 外的全部文件；未列出的文件视为校验失败。列了但不存在的文件同样失败。
- `files` 的值统一使用 `contentHash` 的纯 hex，不带 `sha256:` 前缀；实现直接比较字符串。
- `name` 只允许 `[a-z0-9][a-z0-9_-]*`，与现有 `isValidStackName` 一致。
- `stack.json` 是安装权威；`index.json` 只用于发现。`stack lint` 校验 `index.json` 的 key 与 `stack.json.name` 一致、`index.json.packs[name].path` 指向的目录存在且包含该 `stack.json`，以及两边的 `detects` 集合一致。
- 包名与探测名解耦：`detects` 只用于粗粒度提示，安装目录名由 `stack.json.name` 或 `--as` 决定。
- `version` 是展示与兼容字段；commit 是最终锁定；tag 是发布标记，约定为 `<pack>@<version>`。
- `minDevflow` 不满足时在安装前拒绝，不等到 `gen` 报错。示例 `>=1.8.0` 假设该能力在 1.8.0 发布；测试 fixture 使用 `>=1.7.0`。
- `detects` 是粗粒度提示，不承诺精确推荐。`vue3` 依赖 `discover.mjs` 补充 Vue 识别后才准确；在此之前文档必须说明它可能落到所有 Node.js 项目。

## 5. 缓存模型

用户级缓存根：`~/.devflow/cache/stacks/<repo-id>/`，可用 `DEVFLOW_CACHE_DIR` 覆盖。`repo-id` 是规范化 URL 去掉凭据后的 SHA-256 前 12 位。

```
~/.devflow/cache/stacks/<repo-id>/
  repo.git/                     # bare，保留 refs 与对象
  snapshots/<commit>/<packId>/  # 不可变物化结果，只含包文件
  snapshots/<commit>/<packId>.meta.json  # 完整性标记，位于包目录外
  locks/
```

不使用可变 sparse 工作树。原因：多个包会互相改写工作树、浅克隆无法恢复旧 commit、并发安装会冲突。

### 5.1 拉取

1. `repo.git` 不存在时执行 `git clone --bare --filter=blob:none <url> repo.git`；不支持 partial clone 的托管端降级为普通 `git clone --bare`。
2. 解析 ref：
   - 分支与 tag 用 `git rev-parse --verify <ref>^{commit}`；
   - 完整 SHA 直接校验存在性；
   - SHA 不走 `--branch`。
3. commit 不在对象库时，按顺序尝试：
   - `git fetch --filter=blob:none origin <ref>`；
   - `git fetch origin <commit>`（部分托管端禁止按 SHA fetch）；
   - 全量 `git fetch origin`；
   - `git cat-file -e <commit>^{commit}` 确认。

   每一步失败都给出具体提示，不拿空对象继续。
4. 默认不做浅克隆。“恢复旧 commit”与 `--depth 1` 冲突；空间由 `--filter=blob:none` 与手动 `stack cache gc` 控制。

### 5.2 物化

不 checkout 工作树，直接按对象读取：

1. `git ls-tree -r -z <commit> -- <path>` 列出文件。
2. 检查 mode：只接受普通文件；`120000`（符号链接）与 `160000`（gitlink）直接拒绝。
3. 用 `git cat-file --batch-check` 获取 blob 大小，先执行 1 MiB / 10 MiB / 500 文件限制，再用 `git cat-file --batch` 读取内容。避免先把超大 blob 读进内存。
4. 校验 UTF-8；非文本拒绝。
5. 在 `snapshots/<commit>/<packId>.staging-<pid>/` 完成内容、`stack.json.files` 哈希与白名单校验。
6. 在包目录外写入 `<packId>.meta.json` 完整性标记，再把 staging 原子 rename 到 `snapshots/<commit>/<packId>/`。包目录内只保留真正的包文件。

`snapshots/<commit>/<packId>.meta.json`：

```json
{
  "schemaVersion": 1,
  "commit": "3f2a1b9c...",
  "packId": "java-spring",
  "files": {
    "_shared.md": "<contentHash hex>"
  }
}
```

复用已有快照前必须校验标记与全部文件哈希。标记缺失、文件缺失或哈希不符时删除并重新物化。原子 rename 只能防半成品，不能防磁盘损坏或人为篡改。

多进程同时物化同一快照：后到者完成 staging 后删除自己的 staging，复用先到者的结果。

### 5.3 离线与并发

- `--offline` 只读 `snapshots/`，不调用 git。
- 缓存与 fetch 使用严格锁；锁超时报错，不降级为无锁执行。
- `stack cache gc` 默认 dry-run，必须 `--apply` 才删除；默认保留 30 天，`--keep-days <n>` 覆盖。
- 只清理 `snapshots/` 下超过保留期的快照目录与对应 `meta.json`；不对 `repo.git` 执行 `git gc --prune`。
- 不在 `add/update` 后自动运行。缓存是用户级目录，无法知道其他项目是否仍引用某个快照；删除后其他项目可能需要重新联网拉取，输出中必须说明。

## 6. 项目侧状态

### 6.1 可复现事实：`.claude/hub/stack-lock.yaml`

入库、工具生成、可提交：

```yaml
version: 1
packs:
  java-spring:
    installedAs: java-spring
    repo: https://github.com/org/devflow-stacks
    packId: java-spring
    path: stacks/java-spring
    ref: main
    commit: 3f2a1b9c...
    version: 1.2.0
```

- 以 `installedAs` 为 key。
- 写入时保留未知顶层字段，并做 round-trip 测试。
- `--from` 本地来源只写本地账本，不写 lock；`stack lock` 遇到 local 来源时跳过并 warning“不可跨机器复现”。v1 不提供 `--lock-local`。

### 6.2 本机安装事实：`.claude/.stack-sources.json`

入库？不。写入 `.gitignore`：

```json
{
  "schemaVersion": 1,
  "packs": {
    "java-spring": {
      "installedAs": "java-spring",
      "repo": "https://github.com/org/devflow-stacks",
      "packId": "java-spring",
      "path": "stacks/java-spring",
      "ref": "main",
      "commit": "3f2a1b9c...",
      "version": "1.2.0",
      "source": "git",
      "installedAt": "2026-11-05T...",
      "files": {
        ".claude/hub/stacks/java-spring/_shared.md": {
          "base": "<contentHash hex>",
          "local": "<contentHash hex>"
        }
      }
    }
  }
}
```

- 以 `installedAs` 为唯一键，同时记录来源身份，避免同名包、不同 ref、`--as` 重命名互相覆盖。
- `base` 是上次安装的包内容哈希，`local` 是上次干净写入的内容哈希。两者都用 `contentHash` 的纯 hex。
- `--from` 来源额外记录 `source: local` 与 `localPath`，不写 `commit`：
  ```json
  {
    "installedAs": "java-spring",
    "source": "local",
    "localPath": "D:/work/devflow-stacks",
    "packId": "java-spring",
    "path": "stacks/java-spring",
    "ref": null,
    "commit": null,
    "version": "1.2.0",
    "installedAt": "2026-11-05T..."
  }
  ```
  本地来源不写 lock，`restore` 无法跨机器恢复。
- 这是本机安装事实。lock 缺失时它仍然决定目录是否受管。
- 文件存在但 JSON 损坏或 `schemaVersion` 不支持时 fail closed：`sync`、`upstream`、`stack add/update/restore` 直接报错并提示 `stack status` / `doctor`，不能当成“没有受管栈”继续。

### 6.3 基线：`.claude/.stack-bases/<installedAs>/`

按包整目录保存上次安装的干净内容，作为三方合并的 base。更新时整目录原子替换，避免逐个文件半更新。

### 6.4 临时目录

- `.claude/.stack-staging/<pid>-<rand>/`
- `.claude/.stack-trash/<timestamp>/<installedAs>/`

两者都进 `.gitignore`，不参与 `guard-generated` 保护；账本与 bases 受保护。

## 7. 状态机

| 目标目录 | 本地账本 | lock | 行为 |
| --- | --- | --- | --- |
| 不存在 | 无 | 无 | 全新安装 |
| 不存在 | 有 | 有 | 按账本与 lock 恢复 |
| 不存在 | 有 | 无 | 按本地账本恢复；提示 lock 缺失 |
| 存在 | 同一 `installedAs` | 有 | 三方合并更新 |
| 存在 | 同一 `installedAs` | 无 | 更新；警告 lock 缺失，可 `stack lock` |
| 存在 | 无 | 有 | 内容一致则采纳；不一致则冲突，`--force` 覆盖 |
| 存在 | 无 | 无 | 拒绝；`--force` 备份后接管 |
| 存在 | 其他 `installedAs` | 任意 | 拒绝，除非先 `remove` |

补充规则：

- lock 缺失不阻断本机操作。它是可复现事实，不是安装事实。
- 同一 `installedAs` 在不同仓库或不同 `packId` 下出现时，以本地账本的 `repo`/`packId` 判断是否同一来源；不同来源要求先 `remove`。同一 `repo` + `packId` 但 `ref` 不同不构成冲突，按 `update` 处理。
- 目录存在但账本无记录时，不拿模板库的 `.hub-sources.json` 猜归属。

## 8. 安装事务

顺序固定：

1. **预检**：包格式、路径、白名单、大小、`contentHash`、`minDevflow`、loader 兼容、目标状态、引用冲突。全部通过前不写任何文件。引用冲突指：目标目录已被其他 `installedAs` 占用，或该路径在 `hub.yaml` 中声明给另一个栈名。未在 `hub.yaml` 中声明只给 INFO，不拒绝安装。
2. 写入 `.claude/.stack-staging/<pid>-<rand>/<installedAs>/`。
3. 写临时账本与临时 bases，并完成 JSON/哈希校验。
4. 旧目录移入 `.claude/.stack-trash/<timestamp>/<installedAs>/`；旧 bases 移入 `.claude/.stack-trash/<timestamp>/<installedAs>-bases/`。
5. staging 换入目标目录；Windows 上不直接 rename 覆盖非空目录，先移走再放入。
6. 临时 bases 整目录原子替换为 `.stack-bases/<installedAs>/`。
7. 账本原子 rename 提交。**这是安装提交点。**
8. 接管原本由模板库管理的目录时，安装提交后删除该栈对应的 `.hub-sources.json` 记录与 `.hub-bases/` 快照；删除失败只 warning，由 `doctor` 报告。
9. 写 lock。lock 失败只警告，不回滚安装，提示 `stack lock` 重建。
10. 运行 `gen`。失败不回滚安装，但输出明确警告；`--no-gen` 可跳过，与 `sync` 一致。

回滚：

- 第 4 步之前失败：清理 staging，状态不变。
- 第 5 步之后、第 7 步之前失败：先把第 6 步换入的新 bases 移入 `.stack-trash/<timestamp>/<installedAs>-new-bases/`；若原目录存在，从旧 trash 恢复目录与旧 bases，再删除新 bases 备份；若原目录不存在，删除新目录与新 bases；删除临时账本。
- 第 7 步成功后删除旧 bases 备份。安装完成。lock、owner 转移与 `gen` 的失败不触发回滚。

锁：缓存 fetch、快照物化、安装账本使用严格锁。给 `common.mjs` 增加 `failClosed` 模式，超时抛错；hooks 的状态锁保持现有降级行为不变。

## 9. 更新语义

以 bases 为 base、项目当前内容为 local、新包内容为 theirs，复用 `mergeTexts`。

| 情况 | 行为 |
| --- | --- |
| 同名文件内容变化 | 三方合并；冲突保留本地并写 `.bak`，同时把新包内容记为基线 |
| 新包新增文件 | 直接写入并入账 |
| 新包删除文件 | 本地未改（`local === base`）才删除；本地改过则保留并警告 |
| 本地删除文件 | 不自动恢复；账本标记缺失，`doctor` 报告 |
| 目录或额外文件 | 保留；`doctor` 报告孤儿文件 |
| 本地手改 | 合并或保留，不被静默覆盖 |

更新完成后重建 bases 与账本，再 `gen`。`--dry-run` 输出每个文件的动作，不落盘。

## 10. 恢复（新机器 / CI）

`stack restore` 读取 `stack-lock.yaml`：

- 目录缺失：按 lock 的 repo/ref/commit 从缓存或远程恢复。
- 目录存在且与 lock 对应 commit 的包内容完全一致：采纳为干净安装，写本地账本与 bases。
- 目录存在但内容不同：保留本地，以 lock 的包内容写 bases，标记 `modified`，`doctor` 报告；`--force` 才覆盖。
- 有 lock 但没有可用来源（缓存缺失且离线）：明确失败，提示先联网恢复。
- 只有本地账本、没有 lock：不能跨机器恢复；提示运行 `stack lock` 或重新 `add`。
- 两者都没有：不处理，输出已安装为空。
- 本地账本有、lock 没有的记录：保留不删除，报告“未在 lock 中”，不静默忽略。

`restore` 只使用 lock 记录的 commit，不跟随分支移动。`update` 才推进 ref。

## 11. 删除

`stack remove <installedAs>`：

- 先扫描 `hub.yaml` 顶层 `stack` 与所有 `subprojects.*.stack`。
- 引用检查只约束破坏性删除：默认删除与 `--purge` 在被引用时始终拒绝，`remove` 不接受 `--force`。用户必须先手工解除声明。v1 不引入 YAML 写入器，避免制造 `gen` 必然报错的状态。
- `--keep` 始终允许，即使仍被引用：它只移除本地账本、bases 与 lock 条目，保留目录，`gen` 不会失效。必须提示它已成为普通栈目录，不再受 pack 更新，后续 `sync` 可能接管。
- 默认把目录整体移入 `.stack-trash/<timestamp>/`，移除本地账本、bases 与 lock 条目，可恢复。
- `--purge` 只删除账本记录且 `local === base` 的文件；额外文件与手改文件保留；目录为空才删除。
- 删除后运行 `gen`，`--no-gen` 跳过。

## 12. 与模板库、sync、upstream 的边界

### 12.1 sync

在 `hub-sync.mjs` 的两处同时处理，不能只在 `files` 里过滤：

- 读取 `.stack-sources.json`，得到受管栈目录集合；账本损坏时 fail closed，不继续同步。
- actions：受管路径一律不处理，`--force` 也跳过。
- `known`：包含受管路径，避免旧 `.hub-sources.json` 记录被误判为“模板已移除”。
- `stack add` 或 `--force` 接管目录时，在安装提交后删除该栈对应的 `.hub-sources.json` 记录与 `.hub-bases/` 快照；删除失败只 warning，`doctor` 报告。因此 manifest 不再保留受管栈的旧记录。
- `stack remove --keep` 后自然回到“无同步基线”状态。
- 每个受管栈输出一条 INFO，不逐文件刷屏。
- 模板库与 pack 同名时，pack 是唯一 owner，不合并两套来源。

### 12.2 upstream / ship

- `upstream --stack` 对受管栈默认拒绝，提示正式回流目标是 pack 仓库。
- `upstream --all` 与 `ship` 共用的收集入口也要过滤受管栈，否则 `--all` 会绕过限制。
- `--allow-fork` 才放行，并在输出中说明改动不会通过 `sync` 回来。

### 12.3 模板库

- 受管栈不参与 `sync` 的来源优先级。
- 用户执行 `stack remove --keep` 后，目录变为“项目已有、无同步基线”，`sync` 默认保留，`--force` 才覆盖。

## 13. 安全与校验

包内容会被注入上下文，按不可信输入处理。

URL：

- 只允许 `https://`、`ssh://`、`git@host:`。`file://` 仅用于 `--from` 的本地来源，不允许写入可提交的 lock。
- 拒绝带 userinfo 的 URL、`ext::`、`transport::` 与以 `-` 开头的值；认证交给 credential helper，不做 HTTP 回退。
- 缓存 ID、日志、lock 与账本中不保存任何凭据。
- git 命令设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never` 与 `spawnSync` 超时。

路径与文件：

- 拒绝 `..`、绝对路径、盘符、反斜杠穿越。
- 用 `lstat` 检查符号链接/junction，不能只 `stat`。
- 拒绝仅大小写不同的重复路径。
- 白名单扩展名；单文件 1 MiB、整包 10 MiB、文件数 500。
- 哈希统一用 `contentHash`（LF 归一化），不要用原始 `sha256`，否则 Windows CRLF checkout 会误报。
- 写入前对每个文件校验 `stack.json.files` 的哈希，且 `files` 必须覆盖全部文件。

兼容性：

- `minDevflow` 不满足时拒绝安装。
- 模板正文引用的 `scripts/devflow-*.mjs` 必须在当前插件 loader 列表中，否则拒绝安装。

- `--force` 的边界：
  - 只覆盖本机目标目录。
  - 不绕过 URL 白名单、路径检查、扩展名、大小限制、哈希、`minDevflow`、loader 兼容性与目标必须在项目内的约束。

- 包正文可能包含危险指令。安装时扫描 `curl | sh`、`rm -rf`、读取密钥等模式并警告，但不执行、不改写；真正的执行边界仍由 hooks 承担。

## 14. 命令面

```bash
devflow stack add <packId> [--repo <url>] [--ref <ref>] [--as <name>] [--from <dir>] [--offline] [--dry-run] [--force] [--no-gen]
devflow stack list [--repo <url>] [--json]
devflow stack update [<installedAs>|--all] [--ref <ref>] [--offline] [--dry-run] [--force] [--no-gen]
devflow stack restore [--dry-run] [--offline] [--force] [--no-gen]
devflow stack remove <installedAs> [--keep|--purge] [--dry-run] [--no-gen]
devflow stack status [--json]
devflow stack lock [--dry-run]
devflow stack lint <path>
devflow stack cache gc [--keep-days <n>] [--apply]
```

参数约束：

- `add` 的 `<packId>` 是仓库 `index.json` 的 key；`update`/`remove` 使用 `installedAs`。`--as` 重命名后，后续命令一律使用安装名。
- `--repo` 与 `--from` 互斥；`--ref` 与 `--offline` 不适用于 `--from`。
- `--from` 指向与远程仓库同形的本地根目录：根下有 `index.json`，包在 `index.json.packs[packId].path` 指向的目录；不是直接指向某个包目录。
- `--as` 必须通过 `isValidStackName`。
- `add`/`update`/`restore`/`remove` 要求项目已存在 `.claude/hub/hub.yaml`。
- `--force` 只用于覆盖本机目标目录（`restore` 用于覆盖与 lock 不一致的本地内容），不绕过任何校验。

- `add` 必须提供 `--repo`、`--from` 或 `DEVFLOW_STACK_REPO`。v1 不设默认源，错误信息给出完整示例。
- `add` 成功后若 `installedAs` 没有被 `hub.yaml` 顶层 `stack` 或任何 `subprojects.*.stack` 引用，输出提示：补充 `stack: <installedAs>`（或对应子项目的 `stack`）后再运行 `gen`。安装本身不改写 `hub.yaml`。
- `list` 不带 `--repo` 只列已安装的包，不触发网络；带 `--repo` 才读取远程 `index.json`。`--json` 区分 `installed` 与 `available`。
- `update` 才移动 ref；`restore` 只按 lock 的 commit 恢复。`update --offline` 只在缓存已有目标 ref 时可用，否则报错。
- 恢复命令命名为 `restore`，避免与 `devflow sync` 混淆。
- `add`/`update`/`restore`/`remove` 默认运行 `gen`；`--no-gen` 跳过。
- 新增 `skills/stack/SKILL.md`，标记 `disable-model-invocation`，只能显式触发。
- 注册到 `scripts/lib/cli-commands.mjs`，并在 `LOADERS` 增加 `devflow-stack.mjs`。

## 15. doctor、status、init

`doctor`：

- lock 与本地账本是否一致。
- 安装文件是否缺失、是否被手改（只报告，不阻断）。
- `hub.yaml` 引用的栈目录是否存在。
- 受管路径是否残留陈旧的 `.hub-sources.json` 记录或 `.hub-bases/` 快照。
- lock 缺失时 warning，可 `stack lock` 重建。
- `--check-remote` 才联网报告落后 commit，默认不联网。

`status`：

- 展示每个受管栈的版本、commit 短哈希与 `modified` 状态。
- 不读取包正文，不触发网络。

`init`：

- 不自动安装任何包。
- 发现 Java/Maven 或 Vue 项目时给一条可执行提示，例如 `devflow stack add java-spring --repo <url>`，不阻塞流程。
- 在 `.gitignore` 片段加入 `.claude/.stack-sources.json`、`.claude/.stack-bases/`、`.claude/.stack-staging/`、`.claude/.stack-trash/`。

## 16. 测试

- 全部使用本地 git fixture 或 `--from` 目录，不访问网络。
- `DEVFLOW_CACHE_DIR` 指向临时目录。
- `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` 指向临时配置，避免用户 `core.autocrlf` 影响哈希。
- 设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`。
- 单元：URL 规范化与凭据剥离、包名与版本解析、`index.json`/`stack.json` 校验、白名单、大小限制、`ls-tree` 模式、快照完整性、账本读写、三方合并。
- 集成：`add → list → update → remove`、离线缓存、冲突合并、新机器 restore、`sync` 跳过受管栈、`upstream --all` 过滤、`doctor` 一致性、Windows 目录替换/junction/大小写冲突、事务回滚。
- 现有测试保持全量通过，不写死数量。
- 新增 `tests/stack-pack.test.mjs` 与 `tests/stack-git.test.mjs`；官方仓库样例作为 fixture 放在 `tests/fixtures/stack-pack/`。

## 17. 发布与版本

- 该能力随下一个 minor 发布；是否升版本由维护者决定，文档不自动改动版本号。
- pack 的 `minDevflow` 应不低于该能力首次发布的版本；测试 fixture 使用 `>=1.7.0` 或显式 mock 插件版本，避免 CI 因门槛全部失败。
- `stack lint` 在非 tag 环境下只校验 `stack.json` 与文件哈希；tag 一致性由发布流水线用 `GITHUB_REF` 或 `git describe --tags --exact-match` 校验。

## 18. 实施顺序

1. `lib/stack-pack.mjs`：清单解析、包校验、白名单、路径与哈希规则。
2. `--from` 本地安装：staging、账本、bases、事务回滚。
3. `lib/stack-fetch.mjs`：bare 缓存、ref/commit 解析、对象物化、快照完整性、离线。
4. `lib/stack-install.mjs`：add/update/restore/remove 状态机与三方合并。
5. `scripts/hub-stack.mjs`、CLI 注册、loader、技能入口。
6. 集成：`sync` 跳过、`upstream`/`ship` 过滤、`doctor`、`status`、`discover` 补 Vue 识别、`init` 提示。
7. 测试 fixture、文档与官方仓库 lint。

## 19. 不在 v1 范围

- 自动安装或自动推荐包。
- 包依赖与版本求解。
- 写入 `hub.yaml` 的 YAML 更新器。
- 从包内执行任意脚本或安装器。
- 自动清理全局缓存。
- 多项目共享账本或服务端索引。
