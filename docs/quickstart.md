# 快速上手

面向第一次使用 devflow 的人：从安装到跑完一个小任务，只走最短路径。阶段细节、规则配置与目录职责分别见 [usage.md](usage.md) 和 [layers.md](layers.md)，这里不重复。

如果你只是做 demo、原型或一次性脚本，建议不要使用 devflow：这些场景直接让 Claude Code 写代码更快，产物与门禁会成为负担。下面面向会继续维护的项目。

## 安装

在 Claude Code 中把仓库加入 marketplace，然后安装插件：

```bash
/plugin marketplace add renhao-wan/devflow
/plugin install devflow@devflow-marketplace
```

需要 Node.js >= 20.11，并且 `node` 在 `PATH` 中。插件没有第三方依赖，不需要 `npm install`。安装或修改 hooks 后要重启一次会话。

## 先选一条路径

- **小功能或快速验证**：`/devflow:init` → `/devflow:req --light <需求>`，之后 implement → test → review。产物主要是 `brief.md`、测试记录与审查结论，通常三份文件。
- **需要方案评审、合规留痕或多人接手**：走完整六阶段，产物约五份文档。

不确定时先用轻量；改动变大时阶段入口会提示升级。不确定用哪个命令时，运行 `/devflow:help`。两条路径共用同一个初始化步骤。

## 初始化工作区

进入你的项目根目录，运行：

```bash
/devflow:init
```

它会在 `.claude/hub/` 建立项目自己的规则真源，探测子项目、测试命令与技术栈，生成 `.claude/skills/devflow-*` 投影，并在 `scripts/` 放一组薄 loader。init 结束时看到投影生成，就表示初始化成功。

init 还会生成规则草稿，但草稿只是占位：默认不补全，也不阻塞流程。你可以直接开始第一个任务；需要让技能根据项目内容补全草稿时，再显式运行 `/devflow:init --draft`。如果项目已有明确配置、不想生成草稿，用 `--no-draft`。

初始化后建议看一眼 `.claude/hub/hub.yaml`，尤其是自动探测出来的测试命令。探测只是初判，命令是否符合项目实际需要你确认；需要人工复核的场景见 [usage.md](usage.md#多根工作区)。

## 跑完第一个任务（轻量，推荐）

直接描述需求即可：

```bash
/devflow:req --light 给登录页增加短信验证码
```

req 阶段会把模糊诉求整理成可验证的验收标准，并把需求与计划合并写入 `docs/devflow/<slug>/brief.md`（例如 `add-login`）。不确定 slug 或下一步时运行：

```bash
/devflow:status
```

status 是只读的。它会告诉当前处于哪个阶段、缺哪份产物、下一条该运行什么命令。只有一个任务时，后续命令可以省略 slug：

```bash
/devflow:implement
/devflow:test
/devflow:review
```

存在多个任务时必须显式带上 slug，例如 `/devflow:implement add-login`；status 会列出候选。

implement 小步实现；test 必须真实运行测试并记录证据；review 按风险决定审查方向，结论没有阻断项才算完成。轻量流程只压缩文档，不减测试与审查。任务完成或交付后，如果本项目改过阶段规则，可以用 `/devflow:upstream` 回灌到个人库或团队库。

## 需要完整流程时

需要方案评审、跨模块改动、迁移或合规留痕时，用完整六阶段：

```bash
/devflow:req <需求>
/devflow:status            # 确认实际 slug
/devflow:plan <slug>
/devflow:implement <slug>
/devflow:test <slug>
/devflow:review <slug>
```

plan 会写清方案、任务拆分、测试策略与回滚。小 bug 不需要走完整流程，用 `/devflow:debug <问题>`：先复现再修复，写一份 `debug.md`；测试通过后由 triage 按实际改动判断是否需要 review。

轻量改动变大时，阶段入口会提示升级为完整流程，并用 `devflow triage --escalate` 按实际 diff 检查硬触发。

## 可选：从技术栈包安装规范

如果团队把 Java、Vue 等规范维护在独立仓库，不必手动复制到 `.claude/hub/stacks/`：

```bash
# 安装单个栈（只取该包的快照，不 clone 整个仓库）
devflow stack add java-spring --repo https://github.com/<org>/<repo>.git

# 本地调试 pack 时直接指向 pack 仓库根目录
devflow stack add java-spring --from ../devflow-stacks
```

安装不会自动改写 `hub.yaml`。在顶层或对应子项目写入 `stack: java-spring`，再运行 `node scripts/devflow-gen.mjs`，阶段执行时才会读到这套规范。之后用 `devflow stack status` 查看状态、`devflow stack update java-spring` 拉取上游改动；冲突会保留本地并生成 `.bak`。提交 `.claude/hub/stack-lock.yaml` 后，新机器初始化完运行 `devflow stack restore` 即可复现。完整命令、合并规则与安全限制见 [usage.md](usage.md#技术栈包stack-packs)。

## 接下来

- 想改项目规则：编辑 `.claude/hub/` 下的文件；不确定放 `_shared/`、阶段、技术栈还是子项目覆盖时，用 `devflow-rule-placement`。改完运行 `node scripts/devflow-gen.mjs`，再用 `node scripts/devflow-doctor.mjs` 体检。
- 插件升级后：用 `/devflow:sync` 同步模板，不要用 `--force` 重跑 init。
- 命令不可用：确认重启过会话，并检查 `~/.claude/settings.json` 的 `enabledPlugins` 是否启用了 `devflow@devflow-marketplace`。
- 想理解目录与读取时机：读 [layers.md](layers.md)；想了解 hooks 与安全边界：读 [hooks.md](hooks.md)。
