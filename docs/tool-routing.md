# 工具路由

devflow 负责阶段顺序、门禁与产物路径；它不要求你只能用 devflow 自带的技法。工具路由允许项目登记同类工具（superpowers、BMAD、Spec Kit、OpenSpec 等），在进入某个阶段时先判断是否有更合适的工具，同时保留“强制使用 devflow”的出口。

## 边界

- 路由只决定**谁执行当前阶段的技法**，不改变阶段顺序、门禁与 `docs/devflow/<slug>/` 产物。
- `technique` 类工具只接管执行技法（brainstorming、TDD、排障、评审）；阶段门禁仍由 devflow 检查。
- `workflow` 类工具会接管整个流程，因此即使 `mode: auto` 也只建议，不自动切换。
- 配置缺失、解析失败或未检测到工具时回退 devflow，不阻塞开发；检测结果本身缺失时会先自动检测一次再决策。

## 快速开始

```bash
# 初始化时自动生成配置并检测（/devflow:init 也会做）
devflow init

# 重新检测已安装的同类工具
devflow route --detect

# 查看模式、工具与检测结果
devflow route --list

# 进入阶段前判断是否需要委派
devflow route --stage plan

# 强制使用 devflow / 显式指定工具
devflow route --stage plan --force-devflow
devflow route --stage plan --tool superpowers
```

阶段入口技能（`/devflow:req`、`/devflow:plan` 等）会自动执行对应的路由判断；手动运行主要用于排查和脚本集成。

## 配置

文件：`.claude/hub/ecosystem.yaml`（提交到仓库，可手改）。

```yaml
version: 1

routing:
  # off：不路由；ask：默认，命中时先询问；auto：自动委派 technique 工具
  mode: ask
  # 这些阶段始终使用 devflow，即使检测到更合适的工具
  forceDevflowStages: []
  # 检测结果超过该天数后提醒更新
  detectMaxAgeDays: 14

tools:
  superpowers:
    label: superpowers
    enabled: true
    kind: technique          # technique | workflow
    stages: [plan, implement, test, review, debug]
    invoke: /superpowers:{capability}
    detectSkills: [brainstorming, test-driven-development, systematic-debugging]
    detectPlugins: [superpowers]
    note: 执行技法；不管理阶段与产物。
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `routing.mode` | `off`、`ask`（默认）、`auto` |
| `routing.forceDevflowStages` | 强制走 devflow 的阶段列表 |
| `routing.detectMaxAgeDays` | 检测结果的有效期（天） |
| `tools.<id>.enabled` | 设为 `false` 可保留配置但停用 |
| `tools.<id>.kind` | `technique` 或 `workflow`；未知值按 `workflow` 处理 |
| `tools.<id>.stages` | 该工具适用的 devflow 阶段 |
| `tools.<id>.invoke` | 调用入口；支持 `{capability}` 与 `{stage}` 占位符 |
| `tools.<id>.detectSkills` | 用于检测的技能目录名 |
| `tools.<id>.detectPlugins` | 用于检测的插件键（`settings.json` 的 `enabledPlugins`） |

省略 `tools` 时使用内置目录（superpowers、BMAD、GitHub Spec Kit、OpenSpec、cc-spec-driven、Claude Code Spec Workflow、ucai）。只写部分工具时，未列出的工具不会参与路由。`tools: {}` 表示不启用任何工具；块形式的空 `tools:` 与省略等价，会回填内置目录。

### 登记新工具

在 `tools` 下新增一个 id 即可，不需要改脚本：

```yaml
tools:
  my-workflow:
    label: My Workflow
    enabled: true
    kind: workflow
    stages: [req, plan]
    invoke: /my-workflow
    detectSkills: [my-workflow]   # 项目或用户 .claude/skills 下的目录名
    detectPlugins: [my-workflow]  # settings.json 中 enabledPlugins 的键
    note: 团队内部流程；仅在 req、plan 建议使用。
```

- `invoke` 支持 `{stage}`，以及内置的阶段技法映射 `{capability}`（plan → brainstorming、implement → test-driven-development、test → verification-before-completion、review → requesting-code-review、debug → systematic-debugging）。
- 写了 `tools` 后内置目录不会自动补齐；需要保留的内置工具请一并列出。省略整个 `tools` 才会使用完整默认目录。
- `detectSkills` 与 `detectPlugins` 必须是单段名称（字母、数字、点、下划线或连字符），不能包含路径分隔符或 `..`。
- 登记只是让路由“知道它存在”；是否真的安装由 `devflow route --detect` 的检测结果决定。

## 检测与隐私

检测结果写入 `.claude/.ecosystem-state.json`（已加入 `.gitignore`），与可提交的 `ecosystem.yaml` 分开，避免每次检测重写用户配置并丢失注释。

检测只做存在性检查：

- 项目与用户目录下的 `.claude/skills/<name>/SKILL.md` 或 `<name>.md`；
- 项目与用户 `.claude/settings.json`、`.claude/settings.local.json` 的 `enabledPlugins` 键。

它**不读取技能内容、不执行外部工具、不在状态文件里记录绝对路径**。检测是启发式的：安装、禁用或升级工具后，运行 `devflow route --detect` 刷新。已设置 `enabled: false` 的工具不参与检测。

由于状态文件被 gitignore，新克隆的项目或清理过状态时，`devflow route --stage <stage>` 会自动检测一次后再给出决策；`--list` 保持只读，不会触发检测。检测的读写都会校验真实路径，拒绝通过 junction / 符号链接写到项目外。

## 路由决策

优先级从高到低：

1. `--force-devflow` / `--no-route` / `--tool devflow`：强制使用 devflow。
2. `--tool <id>`：显式指定工具；未知、已禁用或不支持当前阶段时报错退出。
3. `routing.mode: off`：不路由。
4. `routing.forceDevflowStages` 命中当前阶段：使用 devflow。
5. 在已检测到、已启用且声明支持该阶段的工具中选择：
   - `req` 优先 `workflow`，其余阶段优先 `technique`；
   - 同类中按配置顺序取第一个。

决策结果：

| decision | 含义 | 阶段入口应做什么 |
| --- | --- | --- |
| `use-devflow` | 使用 devflow | 直接继续 |
| `suggest` | 有更合适的候选 | 说明理由并询问；用户未同意则继续 devflow |
| `delegate` | 委派给候选工具 | 调用候选工具执行技法，门禁与产物仍由 devflow 负责 |
| `error` | 显式指定的工具不可用 | 停止并报告原因 |

`auto` 只对 `technique` 自动产生 `delegate`；`workflow` 始终是 `suggest`。

## 轻量入口（`--light`）

轻量功能（`/devflow:req --light`）与轻量修复（`/devflow:debug`）同样遵守上面的路由顺序，但有两个额外约束：

- `--light` 表示用户已选定轻量路径，**不切换 workflow 工具**：req 入口会给路由命令附加 `--force-devflow`，避免 BMAD、Spec Kit、OpenSpec 等接管 req 阶段。若同时显式传 `--tool <id>`，轻量优先、该参数不生效；需要改用其他工具或完整规格流程时，去掉 `--light` 后重新执行。
- 轻量修复仍可委派 `technique` 工具执行排障技法（如 superpowers 的系统化排障），但 `docs/devflow/<slug>/debug.md` 是唯一产物，不并存第二份报告；`review: required` 与升级判断也只写在该文件顶部。

轻量任务的 implement / test / review 阶段不受影响：按普通路由执行，阶段顺序、门禁与产物仍由 devflow 负责。

## 命令参考

```
devflow route --stage <stage> [--tool <id>] [--force-devflow] [--json]
devflow route --detect [--json]
devflow route --list [--json]
```

- `--home <dir>`：检测时使用的用户目录，主要用于测试隔离。
- `--json`：stdout 只输出 JSON；日志与提醒走 stderr。
- `--detect --list`：先检测，再输出列表；带 `--stage` 时先检测，再输出最终决策。组合命令的 stdout 始终只有一份 JSON。
- `--stage` 缺失时退出码 1。
- 显式 `--tool` 未知、禁用或阶段不匹配时退出码 1。
- 配置损坏、状态缺失、未检测到工具时退出码 0（fail-open）。

## 安全

- 钩子与本机制都保持 fail-open：路由失败不会阻塞阶段执行。
- 外部工具调用仍受其自身权限与 devflow hooks 约束；路由不会绕过危险命令保护。
- `ecosystem.yaml` 是项目输入，不要写入凭据或私密路径；`invoke` 只应指向可信工具。
- 不要把检测结果当作“工具一定可用”的保证：它只是提示，实际调用失败时按普通工具失败处理。

## 与同类工具的关系

工具路由不是把 devflow 换成另一个工作流，而是避免重复实现已有技法：

- 需要发散方案、TDD、系统排障、代码评审时，优先用已安装的 `technique` 工具；
- 需要阶段顺序、产物路径、门禁与回灌时，始终用 devflow；
- 想整体改用 BMAD、Spec Kit 等工作流时，显式 `--tool <id>`，并理解这会替换 devflow 的流程约束。
