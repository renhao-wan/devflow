# 测试指南

## 命令探测

devflow 初始化会按文件探测默认命令；多根工作区请按子项目覆盖：

| 项目类型 | 探测信号 | 默认命令 |
| --- | --- | --- |
| Node | `package.json` 有 test 脚本 | `npm test` |
| Maven | `pom.xml` | `mvn test` |
| Gradle | `gradlew` / `build.gradle` | `./gradlew test` |
| Go | `go.mod` | `go test ./...` |
| Rust | `Cargo.toml` | `cargo test` |
| Python | `pyproject.toml` / `pytest.ini` | `pytest` |

在 `hub.yaml` 中按子项目覆盖：

```yaml
subprojects:
  api:
    path: services/api
    stages: [plan, implement, test, review, debug]
    testCommand: "npm test --workspace api"
```

## 分层

- **单元**：快、无外部依赖，覆盖分支与边界。
- **集成**：验证模块间契约、数据库、消息。
- **端到端**：少量主流程，不追求覆盖全部路径。

## 失败处理

1. 先看失败原因：断言 / 编译 / 环境。
2. 断言失败 → 判断是实现错还是期望错；期望错要说明依据。
3. 环境失败 → 先修环境，不要改测试绕过。
4. 不稳定测试 → 找根因（时间、顺序、共享状态），不加 sleep。

## 覆盖判断

不追求数字，追求关键路径：

- 每条验收标准至少一个测试或明确的手动验证。
- 每个修过的 bug 一条回归测试。
- 每个对外接口的正常与错误路径各一条。

## 记录

通过后运行：

```bash
node scripts/devflow-test.mjs --command "<命令>"
```

写入 `.claude/.devflow-state.json`，供 Stop 钩子判断是否需要提醒。
