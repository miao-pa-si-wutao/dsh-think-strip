# dsh-think-strip

[![CI](https://github.com/miao-pa-si-wutao/dsh-think-strip/actions/workflows/ci.yml/badge.svg)](https://github.com/miao-pa-si-wutao/dsh-think-strip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> [English](README.md) · **中文**

把历史里的**思考（reasoning）块**和**过长的工具输出**从模型上下文中剥离，原文按时间戳归档到磁盘并建可检索索引：思考每处留一行摘要，工具结果留「头 1200 字 + 尾 400 字」预览 + 归档路径。

聊天输入框左侧有**两个开关**（思考 / 工具），**按会话独立**，互不影响；新会话走默认值。

## 它解决什么

DeepSeek Harness 每次请求都会把历史 assistant 消息里的 `reasoning` 块原样回传（`dsh-llm-deepseek/lib/index.js` 的 `assistant()` 里 `case "reasoning"` 没有任何过滤），工具结果也整段回传。在真实会话 `session-f0b74f94`（1101 条工具结果 / 1118 条 assistant 消息）上实测：

| 项目 | 数值 |
| --- | --- |
| 工具输出总字符 | 2,163,722 |
| 其中 ≥4000 字符的 | 128 条，合计 1,426,922 字符（66%） |
| 思考块 | 776 块，合计 1,078,446 字符 |
| tool/result 的 content 形状 | `text` × 1069、`text,image` × 32 |

也就是说：压缩 128 条长工具输出可省约 122 万字符，剥离思考可省约 108 万字符，两项都是百万字符级。

同时保证：

- **不改写 append-only 会话日志**。原文永远在 `session.v4.jsonl.zstd` 里，fork / resume / replay 不受影响。
- **KV cache 前缀不受损**。剥离散布在历史中段，但一旦剥离完成，后续每步的消息序列保持字节一致，前缀缓存照常命中。
- **原文可查**。每条被剥离的内容写成独立 JSON 文件，索引汇总在 `index.jsonl`；工具输出的替换文本里直接写了归档绝对路径。

## 工作原理

两条通道配合，都不碰日志原文：

1. `appendPluginRecord(session, 'plugin:think-strip', { targets, indexed })` —— 写一条 `ignorable: true` 的插件记录。它不进 surface nodes、不改 contentGeneration 之外的任何状态，DSH 重启后仍能重放。
2. `ctx.sessions.registerMessageProjection({ type: 'plugin:think-strip', project })` —— 注册同类型名的投影。fold 时把记录点名的 seq 换成**冻结副本**（`message.id` 保留不变）。

`targets` 每项是 `{ seq, kind, summary?, replacement? }`，`kind` 为 `'reasoning'` 或 `'tool'`。**没有 `kind` 的旧记录按 `'reasoning'` 解释**，所以 v0.1 写的记录继续有效，老会话不会因为升级而失效。

时序：监听 `agent/turn-stopping`（回合即将关闭，模型不再欠回复）→ 回扫**全部历史** → 先归档原文 → 再提交一条记录覆盖全部目标 seq。

回扫全部历史而不是只扫本轮，是因为插件启用前、或开关打开前的回合也积压着原文，只处理当轮会让它们永远留在上下文里。已处理过的消息经 `session.deriveEventMessage(event)` 读出来时已经不含原文（投影已应用），所以天然幂等跳过。同时会用 `session.surface.nodes` 作白名单，跳过已被压缩遮蔽的旧消息。

### 为什么不是别的做法

| 候选 | 为什么不行 |
| --- | --- |
| `agent/pre-step` 改写 `messages` | 该数组只是本步新认领的 user 批次，历史不在其中（`dsh-agent-loop/lib/index.js:902-927` 的 `this.inbox.claim(...)`） |
| surface replace 写 `assistant/message` | 源码硬拦：`assistant/message embeds its source stream and cannot carry sourceEventSeqs` |
| `llm/stream` waterfall 改 `options.messages` | 请求是 deep-frozen 的，「listeners read it, never rewrite it」 |
| `agent/request` waterfall | 官方明示「this waterfall cannot mutate messages」 |
| 直接 `session.append()` 自定义类型 | 普通 append 无法设置 `ignorable`，会话重开会拒绝未知事件 |
| 内置 `tool-result-pruner` | 本机这版 DSH 上它是坏的：读 `event.data.message.content[0].content`（假设嵌套结构），而实际是扁平 `ContentBlock[]` → `pruneContent(undefined)` 抛错。而且 `cordis.yml:321` 本来就是 `disabled: true` |

## 两个会话级开关

输入框左侧两个 `role="switch"` 的小按钮：

- **思考** —— 本会话是否剥离历史思考内容
- **工具** —— 本会话是否压缩历史里过长的工具输出

状态按 `sessionId` 存在 `<archiveDir>/switches.json`：

```json
{
  "defaults": { "reasoning": true, "tools": false },
  "sessions": { "session-f0b74f94": { "reasoning": false } }
}
```

优先级：**会话覆盖 > `defaults` > Config**。开关只决定「这一轮要不要提交新的剥离记录」，**已经提交的记录永远继续生效**（日志不可改写，这是设计使然）。想撤销某个会话的剥离，只能归档该会话或接受它继续被投影。

查询 / 修改（只接受 loopback）：

```powershell
# 读
Invoke-RestMethod 'http://127.0.0.1:<DSH_WEB_PORT>/think-strip/state?sessionId=session-f0b74f94'

# 关掉该会话的思考剥离；tools:null 表示清除覆盖、回落到默认
Invoke-RestMethod 'http://127.0.0.1:<DSH_WEB_PORT>/think-strip/state?sessionId=session-f0b74f94' `
  -Method Post -ContentType 'application/json' -Body '{"reasoning":false}'
```

## 归档布局

```
<archiveDir>/
├── switches.json                    # 会话级开关
├── index.jsonl                      # 每行一条索引
├── plugin.log                       # 启动标记（排查 apply 有没有跑）
└── <sessionId>/
    ├── 2026-10-20T10-33-24-123Z-t3-s1-q42.json      # 思考
    └── 2026-10-20T10-33-24-456Z-tool-97.json        # 工具输出
```

单条归档文件内容（思考）：

```json
{
  "kind": "reasoning",
  "time": 1760950000000,
  "sessionId": "session-f0b74f94",
  "turn": 3,
  "step": 1,
  "seq": 42,
  "model": "deepseek-v4.1-flash",
  "chars": 2514,
  "summary": "用户要算 1+1。",
  "reasoning": "（完整思考原文）",
  "text": "（该条回复的正文）"
}
```

单条归档文件内容（工具输出）：

```json
{
  "kind": "tool",
  "time": 1760950000000,
  "sessionId": "session-f0b74f94",
  "turn": 3,
  "step": 1,
  "seq": 97,
  "toolName": "pwsh",
  "chars": 49932,
  "summary": "pwsh 输出 49932 字符",
  "text": "（工具输出全文）"
}
```

索引行：

```json
{"time":1760950000000,"sessionId":"session-f0b74f94","kind":"tool","turn":3,"step":1,"seq":97,"toolName":"pwsh","chars":49932,"summary":"pwsh 输出 49932 字符","file":"session-f0b74f94/2026-10-20T10-33-24-456Z-tool-97.json"}
```

检索示例（PowerShell）：

```powershell
# 按关键词找
Select-String -Path "$env:USERPROFILE\.dsh\think-archive\index.jsonl" -Pattern "关键词"

# 只看工具输出、按字符数排
Get-Content "$env:USERPROFILE\.dsh\think-archive\index.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.kind -eq 'tool' } |
  Sort-Object chars -Descending |
  Select-Object -First 20
```

模型在上下文里看到的工具结果是：

```
（头部若干字）
…[工具输出已归档]…
（原文 49932 字符已归档：<DSH_HOME>\think-archive\session-xxx\2026-….json；可用 read 或 grep 读取）
…（尾部若干字）
```

需要细节时它会自己去读那个文件 —— 省掉的是「无差别塞进上下文」，不是信息本身。

## 配置

写在 profile 的 `cordis.patch.yml` 里，按 id 覆盖：

```yaml
- id: dsh-think-strip
  config:
    enabled: true
    archiveDir: ''
    archive: true
    summaryMode: first-line
    summaryMaxChars: 100
    minReasoningChars: 0
    keepSummary: true
    reasoningDefault: true
    toolsDefault: true
    toolStripChars: 4000
    toolHeadChars: 1200
    toolTailChars: 400
    trace: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后两个功能都不再处理新回合，已提交的记录仍生效 |
| `archiveDir` | `''` | 归档根目录；空 = `<DSH_HOME>/think-archive` |
| `archive` | `true` | 是否写盘。关掉则只剥离不留档（不建议：归档失败的内容不会被投影） |
| `summaryMode` | `first-line` | `first-line` 取思考首行；`none` 只留 `[思考已归档]` 占位 |
| `summaryMaxChars` | `100` | 摘要最大字符数 |
| `minReasoningChars` | `0` | 思考短于此值不剥离 |
| `keepSummary` | `true` | 是否在剥离位置插一行摘要正文 |
| `reasoningDefault` | `true` | 没单独设置过的会话，默认是否隔离思考 |
| `toolsDefault` | `true` | 没单独设置过的会话，默认是否隔离工具输出 |
| `toolStripChars` | `4000` | 工具结果纯文本超过此长度才压缩；`0` = 全部压缩 |
| `toolHeadChars` | `1200` | 压缩后保留的头部字符数 |
| `toolTailChars` | `400` | 压缩后保留的尾部字符数 |
| `trace` | `true` | 每回合往 `plugin.log` 写一行工作记录（排查「为什么没生效」时看它） |

## 注意

- **投影注册在插件里**。卸载插件会让用过它投影的会话拒绝继续派生（`session message projection "plugin:think-strip" was removed or replaced`）。要卸载，先把这些会话归档或接受它们不能再打开。
- **每轮一条记录**，不是每步一条。一轮里多个 step 的内容会被同一条记录覆盖。
- **工具输出只处理「全部是 text 块」的结果**。含图片 / 文件 / 结构化块的（实测 32/1101 条是 `text,image`）整条跳过 —— 拆图片块的风险大于收益。
- **归档失败的内容不会被投影**。原文落盘失败的 seq 会留在上下文里并打一条警告 —— 宁可不省 token，也不让原文丢失。
- 压缩（compaction）把历史整段替换成摘要后，被遮蔽的 seq 不再在 surface 上，投影会静默跳过。
- **插件记录里不能出现 `undefined` 值**。`Session.append` 用 `snapshotJsonValue` 校验，只接受 boolean / string / 有限 number / plain object / plain array，碰到 `undefined` 直接抛 `session event "…" carries non-JSON-serializable data`，投影就提交不上（归档照写，但上下文不变）。所以提交前一律过一遍 `toJsonSafe()`（`lib/pure.js`），它用 JSON 往返削掉 undefined 键。
- **改插件源码必须重启 DSH**。`node_modules` 下的模块不参与 HMR，只改配置才会热生效。
- 启停标记：`<archiveDir>/plugin.log` 里每次 apply 写一行；`trace` 打开时每个回合再写一行 `turn=N sid=… sw=r1t1 ev=事件数 sf=surface节点数 targets=命中数 committed|targets=0|FAILED`，用来区分「插件没起来」「起来了但没触发」「触发了但没命中」「命中了但提交失败」。

## 测试

纯逻辑层（`lib/pure.js`）可以脱离 Harness 跑：

```powershell
cd dsh-think-strip
node --test test/pure.test.mjs
```

## 安装

```powershell
# 在 DSH 里：
#   plugin_manager action=install_bundle target=<本包绝对路径>
```

或手动在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-think-strip
      name: 'dsh-think-strip'
```

Client 半部由 `package.json` 的 `dsh.client.platform = "web"` + `exports["./client"]` 声明，Host 会自动把它注入 Web UI。

## 许可

MIT
