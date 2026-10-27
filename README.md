# devflow

Claude Code 的六阶段工程工作流插件：需求、计划、实现、测试、评审、调试。

核心思路只有一句：**规范正文只放一份（项目 `.claude/hub/`），Claude Code 看到的只是薄壳投影。**

## 安装

```bash
# 把本目录放到任意位置，然后在 Claude Code 中：
/plugin marketplace add D:/projects/devflow
/plugin install devflow
```

个人本地使用不需要发布到公开市场，也不需要 npm。

## 初始化一个工作区

```bash
cd <工作区根>
/devflow:init
```

`/devflow:init` 会：

1. 创建 `.claude/hub/`（六个阶段的模板）
2. 写入 `hub.yaml`（自动探测子项目和测试命令，支持 `services/api` 这类两层结构）
3. 在 `scripts/` 放四个薄 loader
4. 生成 `.claude/skills/devflow-*` 投影
5. 写入 `.gitignore` 片段

然后按需修改 `.claude/hub/hub.yaml` 和各个 `stages/*/SKILL.md`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/devflow:init` | 初始化工作区 hub |
| `/devflow:req` | 需求澄清，产出 `req.md` |
| `/devflow:plan` | 计划，产出 `plan.md` |
| `/devflow:implement` | 按计划实现 |
| `/devflow:test` | 运行与补充测试 |
| `/devflow:review` | 代码评审 |
| `/devflow:debug` | 系统化调试 |
| `/devflow:doctor` | 体检版本、投影、hooks |
| `/devflow:upstream` | 把项目经验回灌到插件模板 |

## 目录

插件自带：

```
.claude-plugin/        # plugin.json + marketplace.json
commands/              # /devflow:* 九个命令
skills/                # 五个通用技能（流程、TDD、评审、排障、hub 管理）
agents/                # 评审、测试、排障三个子代理
hooks/                 # 四个钩子脚本与 hooks.json
templates/             # init 时复制到项目的阶段模板
references/            # 评审清单、测试与排障指南
scripts/               # init / gen / doctor / upstream / mark-test
tests/                 # node:test 测试
```

项目内由 init 生成：

```
.claude/hub/           # 项目真源
├─ hub.yaml            # 子项目、阶段、测试命令
├─ stages/<stage>/     # 六个阶段的正文
└─ _shared/            # 跨阶段共用规则

.claude/skills/        # 生成物，勿手改
scripts/               # 薄 loader，指向插件内的真实脚本
```

## 门禁

- 系统级破坏命令（`rm -rf /`、`mkfs`、`dd` 写裸设备、强推 `main`、`DROP DATABASE`）直接阻止。
- 有丢数据风险但常见可恢复的操作（`git reset --hard`、`git clean -fdx`、强推非保护分支、删除远端分支、发布包）要求用户确认。
- 改了代码但本会话没跑测试：结束前提醒，不阻止。
- 其余阶段门禁写在各 `stages/<stage>/SKILL.md` 里，靠命令流程约束。

hooks 只对包含 `.claude/hub/hub.yaml` 的项目生效，不会打扰其他项目。安装或修改 hooks 后需要重启 Claude Code 会话生效；运行环境需能在 PATH 中找到 `node`。

## 回灌

```bash
# 预览：显示分类与 diff，不写文件
/devflow:upstream --stage plan

# 确认后写入插件模板，自动 bump patch 版本并更新 CHANGELOG
/devflow:upstream --stage plan --apply
```

含项目路径、内网地址、业务名、子项目名的内容会被判定为 project-local，不回灌。

## 版本

- 插件版本：`.claude-plugin/plugin.json`
- 项目要求：`hub.yaml` 的 `requiresPlugin`
- 生成账本：`.claude/.hub-manifest.json`

版本不兼容时生成器拒绝写入，并提示先升级插件。

## 卸载

```bash
/plugin uninstall devflow
rm -rf .claude/hub .claude/skills/devflow-* .claude/.hub-manifest.json scripts/devflow-*.mjs .devflow.json
```

`.claude/` 下你自己写的其他技能不受影响。

## 设计文档

见 `docs/design.md`。
