# 插件开发

面向修改 devflow 插件本身的维护者，说明脚本、目录结构、测试、CI 与版本约定。日常使用与项目配置见根目录 [README](../README.md) 与 [usage.md](usage.md)。

## 脚本参考

| 脚本 | 作用 | 常用参数 |
| --- | --- | --- |
| `bin/devflow` | 统一 CLI：`init` / `gen` / `doctor` / `status` / `onboard` / `statusline` / `route` / `sync` / `upstream` / `ship` / `test` | 透传给对应脚本 |
| `scripts/hub-init.mjs` | 初始化工作区，创建生态索引并检测工具 | `--root` `--force` `--plugin-root` `--source-root` |
| `scripts/hub-onboard.mjs` | 扫描项目并生成/更新 `.claude/hub/project-overview.md` | `--root` `--print` `--json` |
| `scripts/gen-claude-skills.mjs` | 生成投影与账本 | `--root` `--check` `--dry-run` `--json` `--force` `--no-plugin` |
| `scripts/hub-doctor.mjs` | 体检配置、版本、投影、资源、hooks、测试命令依赖与工具检测 | `--root` `--json` |
| `scripts/hub-status.mjs` | 只读扫描任务产物，推导阶段并给出下一步命令与路由状态 | `--root` `--slug` `--json` |
| `scripts/statusline.mjs` | 输出单行进度，供 Claude Code `statusLine` 使用 | `--root` `--json` |
| `scripts/hub-route.mjs` | 检测同类工具并判断当前阶段是否委派 | `--root` `--stage` `--tool` `--force-devflow` `--detect` `--list` `--home` `--json` |
| `scripts/hub-upstream.mjs` | 回灌阶段模板到个人库、团队库或上游 | `--stage` `--shared` `--all` `--to` `--pr` `--apply` `--bump` `--revert` `--force` `--root` `--plugin-root` `--personal-library` `--team-library` |
| `scripts/hub-ship.mjs` | 回灌 + 分支 + 提交 + 推送 + PR（上游或团队 profile） | `--stage` `--plugin-root` `--profile` `--base` `--bump` `--dry-run` `--resume` `--no-pr` |
| `scripts/hub-sync.mjs` | 按来源优先级同步阶段与共享模板 | `--dry-run` `--force` `--no-gen` `--plugin-root` `--personal-library` `--team-library` |
| `scripts/mark-test.mjs` | 记录测试通过时间与命令 | `--root` `--command` |

项目内初始化后会生成同名薄 loader：`scripts/devflow-gen.mjs`、`devflow-doctor.mjs`、`devflow-route.mjs`、`devflow-upstream.mjs`、`devflow-test.mjs`，它们指向插件内的真实脚本。loader 属于生成物，会被写进 `.gitignore`；换机器或重跑 `/devflow:init` 时自动重建。加载顺序为当前会话的 `CLAUDE_PLUGIN_ROOT` → `.devflow.json` 的 `pluginRoot` → `pluginSourceRoot`，任一可用即可。

## 目录结构

插件自带：

```
.claude-plugin/        # plugin.json + marketplace.json
bin/devflow            # 统一 CLI，参数透传给 scripts/
skills/                # 十三个入口技能（req…sync、status、onboard）+ 六个通用技能
agents/                # 评审、测试、排障三个子代理
hooks/                 # 七个钩子脚本、hooks.json 与共用 lib.mjs
templates/             # init 时复制到项目的阶段模板
references/            # 评审清单、测试与排障指南
scripts/               # init / gen / doctor / status / onboard / statusline / route / upstream / ship / sync / mark-test
scripts/lib/           # 共用：路径归一化、YAML 解析、版本与 semver、工具生态
evals/                 # 行为评测用例（claude plugin eval）
tests/                 # node:test 测试
.github/               # GitHub Actions 与 PR 模板
docs/README.md         # 文档索引与阅读顺序
docs/usage.md          # 阶段细节、hub.yaml、资源、投影、多根工作区、statusline
docs/hooks.md          # hooks 作用域、生成物写保护、deny/ask 清单
docs/maintenance.md    # 回灌、升级、启用状态、ship/PR、故障排查
docs/development.md    # 本文件：脚本、结构、测试、版本
docs/design.md         # 设计文档
docs/native-capabilities.md  # Claude Code 原生能力接入、版本与降级
docs/comparison.md     # 与同类工作流插件的对比与定位
docs/value-and-limits.md  # 价值、适用边界与验证方法
docs/tool-routing.md   # 工具生态索引、检测与路由
SECURITY.md            # 漏洞报告与安全边界
LICENSE                # MIT
package.json           # 发布元数据与 npm test 脚本
```

项目内由 init 生成：

```
.claude/hub/           # 项目真源
├─ hub.yaml            # 子项目、阶段、测试命令
├─ ecosystem.yaml      # 同类工具索引与路由模式
├─ project-overview.md # 项目概览：自动段 + 人工补充（onboard 生成）
├─ stages/<stage>/     # 六个阶段的正文与资源
│  ├─ SKILL.md
│  ├─ references/      # 按需读取的细则（可选）
│  └─ templates/       # 产出骨架（可选）
├─ overrides/          # 子项目级覆盖（可选）
└─ _shared/            # 跨阶段共用规则，生成时注入每条投影

.claude/skills/        # 生成物，勿手改
.claude/.hub-manifest.json   # 生成账本（哈希与资源清单）
.claude/.hub-sources.json    # 阶段源文件账本，供 sync 判断是否手改
.claude/.devflow-state.json  # 测试状态
.claude/.ecosystem-state.json # 工具检测结果（gitignore）
scripts/               # 薄 loader，指向插件内的真实脚本
.devflow.json          # 插件位置、版本、回灌源码根与个人/团队库本机路径
```

## 开发与测试

```bash
node --test
```

不带路径参数，由 Node 在仓库内自动发现 `**/*.test.mjs`。不要写 `node --test tests/`：Node 22.x 起目录参数不再被当作搜索目录，而会当模块路径执行并报 `MODULE_NOT_FOUND`。

- 测试使用 `node:test`，无外部依赖；当前共 311 项，覆盖脚本、hooks、清单一致性、模板约定、CLI、状态视图、statusline、工具路由、模板库解析、多来源同步、回灌、评测用例结构、文档链接与端到端链路。
- 运行测试与插件运行均要求 Node >= 20.11，与 `package.json` 的 `engines` 一致。
- 改动约定：项目规则只编辑 `.claude/hub/`；插件开发时编辑插件源码与 `templates/`。不要手改生成的 `.claude/skills/devflow-*`。
- 修改模板或 hub 配置后，依次运行 `node scripts/devflow-gen.mjs` 与 `node scripts/devflow-doctor.mjs`。

CI 由 `.github/workflows/test.yml` 驱动，在 push 到 `main` 和 PR 时运行：

- `syntax`：Node 20 / 22 下对所有受版本控制的 `*.mjs` 执行 `node --check`，并逐个解析 `*.json`；
- `plugin-manifest`：校验插件清单、版本一致性与 tag 预览；
- `test`：Ubuntu Node 20 / 22、Windows Node 22（matrix 排除了 Windows + Node 20），执行 `node --test`；
- `smoke`：在 Linux 与 Windows 的临时目录执行 `init → gen --check → doctor`，并确认 loader 已生成且被 `.gitignore` 忽略；
- `smoke-result`：汇总两个平台的冒烟结果，以固定名称 `init → doctor` 上报，供分支保护作为必填检查。

### 行为评测（evals）

`evals/` 存放插件行为的评测用例（阶段路由、生成物保护、危险命令拒绝），每个用例是一个带 frontmatter 的 `prompt.md`，grader 以内联 `graders:` 声明。`claude plugin eval` 目前处于 early access，未在本仓库 CI 中运行；用例结构由 `tests/evals.test.mjs` 校验。启用后可在插件目录运行：

```bash
claude plugin eval evals --no-publish --allow-tools Read,Glob,Grep,Bash
```

运行前请先看 `evals/README.md`，其中说明了每条用例的允许工具与判定方式。

## 版本与兼容

`plugin.json` 是插件版本的权威来源；另外两处是镜像，必须与之一致（`tests/manifest.test.mjs` 会校验）：

- 权威来源：`.claude-plugin/plugin.json` 的 `version`（当前 `1.6.0`）
- 包元数据：`package.json` 的 `version`
- 市场条目：`.claude-plugin/marketplace.json` 中同名插件的 `plugins[].version`

`marketplace.metadata.version` 是市场自身的元数据，`upstream` / `ship` 会一并同步，但它不决定插件安装版本。

回灌与 `ship` 的 `--apply` 会同时更新以上位置；手工改版本时也要保持同步。

其他记录：

- 项目要求：`hub.yaml` 的 `requiresPlugin`
- 生成账本：`.claude/.hub-manifest.json`
- 源文件账本：`.claude/.hub-sources.json`

升级插件后先运行 `/devflow:sync --dry-run` 与 `/devflow:doctor`。版本不满足时，生成器会拒绝写入；此时要么调整 `requiresPlugin`，要么回退插件版本。
