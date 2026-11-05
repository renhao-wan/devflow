# 分层与扩展点

日期：2026-11-04

本文回答四个问题：

1. devflow 的三层是什么；
2. `.claude/hub/` 里每个目录干什么；
3. AI 在什么时候读取哪一份规则；
4. 同步与回灌分别把内容送到哪里。

> **状态说明**
>
> `stages/`、`_shared/`、`overrides/`、`stacks/` 均已实现：入口先读项目投影，投影只记录 `_shared/`、`overrides/` 与 `stacks/` 的路径，正文在执行阶段惰性读取；`stacks/` 参与同步、回灌与 `doctor` 校验。`init` 可生成规则草稿，探测到单一技术栈时会自动声明 `stack`。

## 1. 三层是什么

```
第 1 层：插件（安装包）
  skills/ + agents/ + hooks/ + templates/ + scripts/ + bin/ + evals/
        │
        │ /devflow:init 或 /devflow:sync
        │ 把启用的模板库合并后复制到项目
        ▼
第 2 层：项目真源 .claude/hub/
  hub.yaml
  stages/<stage>/{SKILL.md, references/, templates/}
  _shared/
  overrides/
  stacks/
  project-overview.md
        │
        │ node scripts/devflow-gen.mjs
        │ 生成薄投影
        ▼
第 3 层：生成物 .claude/skills/devflow-*
  devflow-req/、devflow-plan/、devflow-implement/ ...
  以及 .claude/.hub-manifest.json 等账本
```

### 第 1 层：插件

| 项 | 说明 |
| --- | --- |
| 位置 | Claude Code 插件目录（marketplace 安装缓存或本机源码仓库） |
| 谁生成 | 插件发布者；你升级插件时更新 |
| 能否手改 | 不要直接改安装缓存，升级会覆盖 |
| 作用 | 提供 `/devflow:*` 入口、默认阶段模板、脚本、hooks、子代理与评测用例 |

它回答的是：**devflow 这个工具本身怎么工作。**

### 第 2 层：项目真源

| 项 | 说明 |
| --- | --- |
| 位置 | 项目根目录的 `.claude/hub/` |
| 谁生成 | `/devflow:init` 首次创建；之后由 `/devflow:sync` 更新 |
| 能否手改 | **可以，而且应该只改这里** |
| 作用 | 定义这个项目每个阶段怎么做、有哪些全局规则、子项目例外和技术栈规范 |

它回答的是：**这个项目自己的流程规则是什么。**

### 第 3 层：生成物

| 项 | 说明 |
| --- | --- |
| 位置 | `.claude/skills/devflow-*/SKILL.md`、`.claude/.hub-manifest.json` 等 |
| 谁生成 | `devflow-gen` 从第 2 层生成；`init` / `sync` 会自动调用 |
| 能否手改 | **不能**，`guard-generated` 会阻止；改了也会在下次生成时被覆盖 |
| 作用 | 把第 2 层的规则包装成 Claude Code 能加载的技能，并记录哈希用于漂移检测 |

它回答的是：**AI 实际加载的入口长什么样。**

### 三层的关系

- 第 1 层是“出厂默认”，第 2 层是“项目定制”，第 3 层是“给 AI 用的出口”。
- 改规则只改第 2 层。新增/删除规则文件或修改 `hub.yaml` 后重新生成第 3 层；只改已有规则正文不需要重新生成，投影只记录路径。
- 第 1 层的 `templates/` 只是第 2 层的来源之一；`init` 之后，项目以第 2 层为准。
- 没有第 2 层时，阶段命令会提示先运行 `/devflow:init`。

## 2. 第二层目录：每个目录干什么

### 2.1 `stages/`

```
.claude/hub/stages/
├─ req/
│  ├─ SKILL.md
│  └─ templates/
├─ plan/
│  ├─ SKILL.md
│  ├─ references/
│  └─ templates/
├─ implement/
├─ test/
├─ review/
└─ debug/
```

这是第二层最核心的目录：每个阶段“做什么、产出什么、过什么门禁”都写在这里。`init` 会从模板库复制六个阶段，通常只需要改 `SKILL.md`；需要展开细则或产出骨架时，再在阶段目录下增删 `references/` 与 `templates/`。

AI 进入阶段时才读 `SKILL.md`；`references/`、`templates/` 不预读，等规则正文或任务需要时再打开。新增/删除阶段资源会改变投影的资源清单，需要运行 `gen`；只改已有文件正文不需要，投影只记录相对路径。它参与同步（对应库里的 `templates/stages/`），也参与回灌（`--stage <name>` 或 `--all`）。

注意：不要为了“让 AI 一定看到”把细则全塞进 `SKILL.md`，按需读取的内容放进 `references/` 更省上下文。

`references/` 与 `templates/` 是 `stages/` 的附属文件：

- `references/`：细则，例如调研方法、审查严重度说明、测试证据要求；
- `templates/`：产出骨架，例如 `req.template.md`、`review.template.md`。

### 2.2 `_shared/`

这里放安全底线、提交约定、通用错误处理这类与具体阶段无关的规则。`init` 会生成 `project-basics.md` 草稿（首行 `<!-- devflow:draft -->`），填写后删除标记才算规则；也可以直接新增 `<topic>.md`。

投影只列出这些文件的路径，不内联正文：改已有文件正文后，下次执行阶段会直接读到新内容，不需要重新生成；新增/删除文件、或把草稿转成正式规则后需要 `gen`（投影清单变化）。`_shared/`、`stacks/`、`overrides/` 与阶段 `references/`、`templates/` 中的草稿不会进入投影、同步与回灌；阶段入口 `SKILL.md` 本身不能标记为草稿。同步对应库里的 `templates/shared/`，回灌用 `--shared` 或 `--all`。

不确定一条规则该放哪时，使用 `devflow-rule-placement` 技能判断落位。

### 2.3 `overrides/`

```
.claude/hub/overrides/
├─ api/
│  ├─ implement.md
│  └─ review.md
└─ web/
   └─ implement.md
```

`.claude/hub/overrides/<sub>/<stage>.md` 只写某个子项目与全局规则的差异。`init` 只建空目录，子目录和文件由你手动创建。

投影会写入“处理该子项目时先读这个文件”的指令，实际读取靠 AI 按指令执行。它比 `stacks/` 和 `_shared/` 更具体、优先级更高，但不能放宽阶段门禁与安全底线。

同步和回灌都不会碰它：这是子项目专属例外，换项目通常不适用。

只写差异，不要整份复制技术栈规范：

```md
# overrides/legacy-api/implement.md

- 本模块继续使用旧 ORM，不适用 Java 栈规范里的新 ORM 约定。
- 其余规范不变。
```

### 2.4 `stacks/`

按语言或框架存放规范，供同一技术栈的多个子项目复用，而不是把同一份规则复制到每个 `overrides/<sub>/`。

```
.claude/hub/stacks/
├─ java-spring/
│  ├─ _shared.md      # 该栈对所有阶段生效（可选）
│  ├─ plan.md         # 该栈在 plan 阶段的规范（可选）
│  ├─ implement.md
│  ├─ test.md
│  ├─ review.md
│  └─ references/     # 可选，由上面的文件按相对路径引用
└─ vue3/
   ├─ _shared.md
   ├─ implement.md
   └─ review.md
```

`_shared.md` 对该栈的所有阶段生效，`<stage>.md` 只对该阶段生效，`references/` 放按需引用的细则。

在 `hub.yaml` 里用顶层 `stack` 声明默认栈，用 `subprojects.<name>.stack` 覆盖；子项目省略时继承。投影只记录“子项目 → 栈 → 文件路径”的映射，不内联正文，所以改栈文件**内容**不需要重新生成；新增/删除栈文件或修改映射才需要。`init` 探测到单一技术栈时会自动写顶层 `stack` 并生成该栈的 `_shared.md` 草稿；草稿不进入投影，填写后删除首行标记再运行 `gen`。

它参与同步（对应 `templates/stacks/`），也参与回灌（`--stack <name>` 或 `--all`）。栈目录缺失、栈名非法、`stack` 不是字符串都会让 `gen` 与 `doctor` 报错，此时 `gen` 仍会写出带「缺失」「名称非法」或「配置无效」标记的投影与账本，但退出码为 1；目录存在但没有任何 `.md` 时只提醒。

映射方式（`hub.yaml` 两级声明）：

```yaml
stack: java-spring          # 工作区默认栈；没有子项目时直接用它

subprojects:
  api:
    path: services/api
    stack: java-spring      # 覆盖默认栈
  web:
    path: apps/web
    stack: vue3
```

规则：

1. 子项目未写 `stack` 时继承顶层 `stack`；没有子项目时使用顶层 `stack` 生成一条“工作区根”映射。
2. 栈名只允许 `[a-z0-9][a-z0-9_-]*`。
3. 被引用的栈目录必须存在；`_shared.md` 与 `<stage>.md` 都可选。
4. 子项目省略或留空 `stack` 都会继承顶层 `stack`；当前不支持子项目显式退出继承。个别子项目需要不同规范时，给它指定另一个栈。

### 2.5 `hub.yaml`

它是项目的配置总表：声明启用的阶段与顺序、默认技术栈、子项目路径与阶段、测试命令、模板来源顺序和插件版本要求。`init` 会自动探测生成，但测试命令与 `stack` 必须人工复核。

`stages` 省略或留空时扫描 `stages/` 目录；写 `[]` 表示不启用任何阶段；写成字符串等非列表类型会被 `gen` 与 `doctor` 报错。同步和回灌都不会改它：不同项目的路径与命令不同。

主要内容：

```yaml
stack: java-spring

subprojects:
  api:
    path: services/api
    stack: java-spring
    stages: [req, plan, implement, test, review]

defaults:
  testCommand: "npm test"

templates:
  order: [team, personal, upstream]
```

### 2.6 `project-overview.md`

记录项目结构、技术栈、入口与子项目。自动段由 `init` 或 `/devflow:onboard` 生成，标记外的内容由你维护，重扫不会覆盖。会话启动只注入一行摘要；`req`、`plan` 需要定位时再读全文。

它是派生文档，不是规则真源，以代码和 `hub.yaml` 为准；不参与同步与回灌。

### 2.7 `ecosystem.yaml`

登记 superpowers、BMAD、Spec Kit 等同类工具与路由模式。阶段入口运行 `hub-route.mjs` 时读取；`init` 会生成默认配置，不同项目可以各自调整，因此不参与同步与回灌。

### 2.8 账本与本机状态

这些文件记录“生成了什么、来自哪里、上次测试结果”，不是规则，不要手改：

- `.claude/.hub-manifest.json`：投影哈希、资源清单与技术栈映射，用于漂移检测，通常入库；
- `.claude/.hub-sources.json`：每个模板文件的来源与基线，schema v3，供 `sync` 判断是否手改，通常入库；
- `.claude/.hub-bases/`：三方合并用的基线快照，通常入库；
- `.claude/.devflow-state.json`：最近一次测试结果，通常入库；
- `.claude/.ecosystem-state.json`：工具检测结果，通常忽略；
- `.devflow.json`：本机插件路径与个人/团队库路径，通常忽略。

## 3. AI 什么时候读取

### 3.1 设计意图

```
① 会话启动
   只加载技能元数据（name + description）
   注入 hub 摘要（阶段、子项目、技术栈、投影漂移）
   不读取任何阶段正文

② 用户进入阶段
   /devflow:plan
     → 加载项目投影 devflow-plan
     → 投影列出 _shared 文件路径
     → 投影要求读取 .claude/hub/stages/plan/SKILL.md
     → 投影列出阶段资源与子项目覆盖

③ 执行阶段
   先完整读取投影列出的 _shared 文件
   按需读取 references/、templates/
   处理某个子项目时读取 overrides/<sub>/<stage>.md
   再读取 stacks/<stack>/<stage>.md 与 stacks/<stack>/_shared.md

④ 技术栈规范
   按投影中的“子项目 → 栈 → 规范文件”映射表读取
   只读任务涉及的子项目，不预读全部
```

### 3.2 完整读取链

`/devflow:<stage>` 的实际行为是：

1. **会话启动**：`load-hub.mjs` 注入摘要（阶段、子项目、技术栈、投影漂移），并返回 `reloadSkills: true`；不读取模板正文。
2. **进入阶段**：加载插件入口 `skills/<stage>/SKILL.md`。
3. **入口先读项目投影** `.claude/skills/devflow-<stage>/SKILL.md`。
   - 投影列出 `_shared/` 文件路径（不内联正文）；
   - 投影列出 `overrides/<sub>/<stage>.md`；
   - 投影给出“子项目 → 栈 → 本阶段规范/通用规范”映射。
4. **按投影指令读取 hub 源** `.claude/hub/stages/<stage>/SKILL.md`。
5. **执行阶段**先完整读取投影列出的 `_shared/` 文件，再按需读取阶段 `references/`、`templates/`；处理子项目时再惰性读取 `overrides/` 与 `stacks/`。

缺失时的回退：

| 情况 | 行为 |
| --- | --- |
| 投影缺失 | 入口直接读 hub 源，并提示运行 `node scripts/devflow-gen.mjs` |
| 投影与 hub 源都缺失 | 提示先运行 `/devflow:init` |

### 3.3 阶段内还会加载什么

除了阶段规则，阶段可能按需使用：

- 子技能：`devflow-plan-research`、`devflow-tdd`、`devflow-code-review`、`devflow-systematic-debugging`；
- 子代理：`devflow-test-runner`、`devflow-code-reviewer`、`devflow-debug-investigator`；
- 外部技法：通过 `hub-route.mjs` 委派给 superpowers 等已安装工具。

这些是“执行方法”，不是“阶段规则”；门禁与产物仍以 devflow 阶段规则为准。

## 4. 冲突与优先级

四个扩展点回答的是不同问题：

| 目录 | 回答的问题 |
| --- | --- |
| `stages/` | 这个阶段做什么、产出什么、过什么门禁 |
| `_shared/` | 所有阶段都必须遵守什么 |
| `overrides/` | 这个子项目有什么例外 |
| `stacks/` | 这个语言或框架的代码该怎么写 |

### 4.1 三条约定

1. **一条规则只放一个家。** 不要在两处重复同一条规则。
2. **越具体越优先。** 先看子项目例外，再看技术栈，再看全局，最后看阶段默认做法。
3. **门禁只能加严，不能放宽。** 技术栈规范和子项目例外都不能取消阶段门禁或安全底线。

### 4.2 优先级

```
阶段门禁与安全底线（最高，不可放宽）
  ↓
overrides/<sub>/<stage>.md（子项目例外）
  ↓
stacks/<stack>/<stage>.md（技术栈规范）
  ↓
stacks/<stack>/_shared.md（技术栈通用规则）
  ↓
_shared/（全局通用规则）
  ↓
stages/<stage>/SKILL.md 中非门禁的默认做法（最低）
```

以上顺序是确定性读取顺序，由投影中的指令约束；生成器与 `doctor` 负责校验映射，不做内容级自动合并。

### 4.3 常见例子

| 规则 | 应该放哪 |
| --- | --- |
| 所有阶段都要写中文提交信息 | `_shared/` |
| Java 类名与分层约定 | `stacks/java-spring/` |
| Vue 组件使用组合式 API | `stacks/vue3/` |
| legacy 模块允许选项式 API | `overrides/legacy-web/` |
| review 必须有测试证据 | `stages/review/SKILL.md`，技术栈不得放宽 |
| plan 的方案结构 | `stages/plan/SKILL.md`，技术栈不得改产出结构 |

不确定某条规则该放哪、或同一规则已在多处出现时，使用 `devflow-rule-placement` 技能；它按“最小充分范围”判断落位并检查是否需要重新生成。

## 5. 同步与回灌

### 5.1 两个方向

```
个人库 / 团队库 / 上游库
        │  init / sync：库 → 项目
        ▼
项目 .claude/hub/
        │  gen：项目 → 投影
        ▼
.claude/skills/devflow-*

项目 .claude/hub/
        │  upstream / ship：项目 → 库
        ▼
个人库 / 团队库 / 上游库
```

### 5.2 同步：库 → 项目

`init` 和 `sync` 会按 `hub.yaml` 的 `templates.order` 读取启用的库，把模板落到项目：

| 内容 | 是否同步 | 说明 |
| --- | --- | --- |
| `stages/` | 是 | 对应库里的 `templates/stages/` |
| `_shared/` | 是 | 对应库里的 `templates/shared/` |
| `stacks/` | 是 | 对应库里的 `templates/stacks/` |
| `hub.yaml` | 否 | 项目配置，由 `init` 生成 |
| `overrides/` | 否 | 项目专属例外 |
| `project-overview.md` | 否 | 派生文档 |
| `ecosystem.yaml` | 否 | 项目级工具索引 |

默认来源顺序是团队 > 个人 > 上游（未启用团队库时个人 > 上游），上游兜底。项目里的手改由基线快照做三方合并保留。首行带 `<!-- devflow:draft -->` 的文件是项目草稿，`sync` 不会覆盖，`--force` 也不覆盖。

### 5.3 回灌：项目 → 库

回灌的“范围”和“目标库”是两个独立维度。

| 维度 | 取值 | 去向 |
| --- | --- | --- |
| 范围 | `--stage <name>` | `.claude/hub/stages/<name>/` → `templates/stages/<name>/` |
| 范围 | `--shared` | `.claude/hub/_shared/` → `templates/shared/` |
| 范围 | `--stack <name>` | `.claude/hub/stacks/<name>/` → `templates/stacks/<name>/` |
| 范围 | `--all` | 所有阶段、所有技术栈；`_shared/` 存在时一并回灌 |
| 目标 | `--to personal` | 个人库，默认 `~/.claude/devflow` |
| 目标 | `--to team` | 团队库，路径由 `hub.yaml` 配置 |
| 目标 | `--to upstream` | 上游插件源码仓库 |
| 修饰 | `--pr` | 团队库或上游库走分支、提交、推送、PR |

`stacks/` 与阶段、共享规则一样可以回灌；技术栈名同样受 `[a-z0-9][a-z0-9_-]*` 约束，`ship` 会把内容写入 `templates/stacks/<name>/`。回灌会跳过草稿；目录里只有草稿时直接报错，提示先填写并删除首行标记。

### 5.4 哪些内容永远不回灌

| 内容 | 原因 |
| --- | --- |
| `overrides/` | 子项目专属，换项目通常不适用 |
| `hub.yaml` | 项目配置，不同项目路径与命令不同 |
| `project-overview.md` | 派生文档，由各项目重新生成 |
| `ecosystem.yaml` | 项目级工具索引 |
| 账本与本机状态 | 本机或项目状态，不是模板 |

### 5.5 回灌后怎么让其他项目用上

1. 在目标项目的 `hub.yaml` 配置 `templates.order`；
2. 运行 `/devflow:sync`；
3. 运行 `/devflow:doctor` 确认无漂移；
4. 如果同步带来的是新增文件，重新生成投影后它才会进入 AI 的读取路径；已有文件的正文不需要重新生成。

回灌只更新库，不会直接修改其他项目的 hub。

## 6. Java / Vue 规范放哪

优先用 `stacks/`：

| 目标 | 放法 |
| --- | --- |
| 同一技术栈的所有子项目、所有阶段 | `.claude/hub/stacks/java-spring/_shared.md` |
| 同一技术栈、只在某些阶段 | `.claude/hub/stacks/<stack>/<stage>.md` |
| 只对某个子项目生效的例外 | `.claude/hub/overrides/<sub>/<stage>.md` |
| 所有阶段都遵守且与语言无关 | `.claude/hub/_shared/` |

配置示例：

```yaml
stack: java-spring
subprojects:
  api:
    path: services/api
    stack: java-spring
  web:
    path: apps/web
    stack: vue3
```

如果栈文件放在 `references/`，在对应栈规范里写清何时读取，例如：

```md
- 修改 Java 代码前，读取 `references/java-style.md`。
```

改完后运行：

```bash
node scripts/devflow-gen.mjs
node scripts/devflow-doctor.mjs
```

栈文件**内容**变化不需要重新生成也能生效，因为投影只记录路径；新增/删除栈文件或修改 `hub.yaml` 的 `stack` 后需要重新生成。

## 7. 常见问题

**hub 创建后是空的吗？**

不是。`init` 会复制六个阶段的完整默认规则，并生成 `hub.yaml`、项目概览与规则草稿：`_shared/project-basics.md`，探测到单一技术栈时还有 `stacks/<stack>/_shared.md`。`overrides/` 默认空，按需添加。

**刚安装插件，项目里有什么？**

只有第 1 层。项目里没有 `.claude/hub/`，阶段命令会提示先运行 `/devflow:init`。

**为什么要有第三层，不能直接读 `.claude/hub/`？**

第三层提供技能发现、规则路径清单、资源清单和漂移检测。它也是 Claude Code 加载技能的入口。

**改规则后要做什么？**

改第 2 层。新增/删除规则文件或修改 `hub.yaml`（阶段、子项目、`stack` 映射）后运行 `devflow-gen`；只改已有规则正文不需要重新生成，但建议运行 `devflow-doctor` 检查漂移、草稿与越界。不要手改第 3 层。

**`_shared/` 改了但没生效？**

先确认首行是否还有 `<!-- devflow:draft -->`：有标记时它只是草稿，不会进入投影、同步与回灌。删除标记后，如果投影里还没有列出该文件路径（新增文件或刚转正），运行 `node scripts/devflow-gen.mjs` 刷新路径清单；路径已在投影中时，下次进入阶段会直接读取最新正文。

**`overrides/` 为什么没被同步或回灌？**

它是项目专属例外，设计上不进入模板库。

## 8. 当前边界

1. **`stacks/` 是机制，不是规范库**：不内置 Java/Vue 等具体栈正文；内容由个人库、团队库或项目自己维护。
2. **技术栈声明不做猜测**：`init` 只在探测到单一技术栈时自动写 `stack`；多栈、未知栈或 `--no-draft` 时保持为空，由项目自行声明。
3. **不做内容级自动合并**：优先级是确定性读取顺序，生成器与 `doctor` 只校验映射是否有效。
4. **不回灌项目配置**：`overrides/`、`hub.yaml`、`project-overview.md`、`ecosystem.yaml` 不同步也不回灌。
