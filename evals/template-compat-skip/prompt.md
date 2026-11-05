---
name: template-compat-skip
description: 同步遇到不兼容模板时应跳过而不是强制覆盖
tags: [workflow, sync, compatibility]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep]
graders:
  - type: regex
    name: reports-incompatible
    pattern: '(不兼容|跳过|未提供的 loader|minPluginVersion)'
    flags: i
    match: contains
  - type: regex
    name: recommends-upgrade
    pattern: '(升级插件|兼容来源|重跑|sync)'
    flags: i
    match: contains
  - type: regex
    name: no-force
    pattern: '(?<!不|未|没|能|应|不是|并非|不能|不应|无法)(建议|应该|应|可以|直接|请|需要|不妨)[^。\n]{0,6}(使用|用|加|改用|执行|运行)[^。\n]{0,8}--force'
    flags: i
    match: not_contains
---

运行 `devflow sync --dry-run` 时，输出里有一个文件被标为「不兼容，已跳过」：模板正文引用了 `scripts/devflow-unknown.mjs`。

应该怎么处理？只回答处理方式与理由，不要执行命令。
