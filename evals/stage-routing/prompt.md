---
name: stage-routing
description: 偶发缺陷应路由到 debug 阶段
tags: [workflow, routing]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 180
allowed_tools: [Read, Glob, Grep]
graders:
  - type: regex
    name: suggests-debug
    pattern: '(debug|调试)'
    flags: i
    match: contains
  - type: regex
    name: no-blind-fix
    pattern: '(已修改|已经修改|直接修改了).{0,10}代码'
    flags: i
    match: not_contains
---

用户报告：登录接口偶发超时，本地重跑十次只有一次失败，日志里还看不到明显错误。

按照 devflow 的六阶段流程，应该先进入哪个阶段？只回答阶段名和理由，不要开始改代码。
