# 快速上手

面向第一次使用 devflow 的人：从安装到跑完一个小任务，只走最短路径。阶段细节、规则配置与目录职责分别见 [usage.md](usage.md) 和 [layers.md](layers.md)，这里不重复。

## 安装

在 Claude Code 中把仓库加入 marketplace，然后安装插件：

```bash
/plugin marketplace add renhao-wan/devflow
/plugin install devflow@devflow-marketplace
```

需要 Node.js >= 20.11，并且 `node` 在 `PATH` 中。插件没有第三方依赖，不需要 `npm install`。安装或修改 hooks 后要重启一次会话。

## 初始化工作区

进入你的项目根目录，运行：

```bash
/devflow:init
```

它会在 `.claude/hub/` 建立项目自己的规则真源，探测子项目、测试命令与技术栈，生成 `.claude/skills/devflow-*` 投影，并在 `scripts/` 放一组薄 loader。init 结束时看到投影生成，就表示初始化成功。

init 还会生成规则草稿，但草稿只是占位：默认不补全，也不阻塞流程。你可以直接开始第一个任务；需要让技能根据项目内容补全草稿时，再显式运行 `/devflow:init --draft`。如果项目已有明确配置、不想生成草稿，用 `--no-draft`。

初始化后建议看一眼 `.claude/hub/hub.yaml`，尤其是自动探测出来的测试命令。探测只是初判，命令是否符合项目实际需要你确认；需要人工复核的场景见 [usage.md](usage.md#多根工作区)。

## 跑完第一个任务

直接描述需求即可：

```bash
/devflow:req 给登录页增加短信验证码
```

req 阶段会把模糊诉求整理成可验证的验收标准，产物写到 `docs/devflow/<slug>/req.md`。不确定 slug 或下一步时运行：

```bash
/devflow:status
```

status 是只读的。它会告诉当前处于哪个阶段、缺哪份产物、下一条该运行什么命令。只有一个任务时，后续命令可以省略 slug：

```bash
/devflow:plan add-login
/devflow:implement add-login
/devflow:test add-login
/devflow:review add-login
```

每个阶段都有明确的产出与门禁：plan 写清方案、任务拆分、测试策略与回滚；implement 小步实现；test 必须真实运行测试并记录证据；review 按风险决定审查方向，结论没有阻断项才算完成。任务完成或交付后，如果本项目改过阶段规则，可以用 `/devflow:upstream` 回灌到个人库或团队库。

## 更短的路径

小功能用 `/devflow:req --light <需求>`：需求与计划合并成 `brief.md`，但测试与 review 仍然保留。小 bug 用 `/devflow:debug <问题>`：先复现再修复，写一份 `debug.md`；测试通过后由 triage 按实际改动判断是否需要 review。轻量流程只压缩文档，不减测试。

改动变大时，阶段入口会提示升级为完整流程，并用 `devflow triage --escalate` 按实际 diff 检查硬触发。

## 接下来

- 想改项目规则：编辑 `.claude/hub/` 下的文件；不确定放 `_shared/`、阶段、技术栈还是子项目覆盖时，用 `devflow-rule-placement`。改完运行 `node scripts/devflow-gen.mjs`，再用 `node scripts/devflow-doctor.mjs` 体检。
- 插件升级后：用 `/devflow:sync` 同步模板，不要用 `--force` 重跑 init。
- 命令不可用：确认重启过会话，并检查 `~/.claude/settings.json` 的 `enabledPlugins` 是否启用了 `devflow@devflow-marketplace`。
- 想理解目录与读取时机：读 [layers.md](layers.md)；想了解 hooks 与安全边界：读 [hooks.md](hooks.md)。
