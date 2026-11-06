# dsh-work-log

DeepSeek Harness（DSH）插件：把**每一轮对话**自动整理成一条可复用的工作记录，按 `根目录 / 工作区 / 对话` 分文件存成 JSON。

不是聊天原文存档——是给另一个 AI 当上下文用的**工作素材**：它会告诉你「用户要求了什么、我们实际做了什么、最后交付了什么」。

## 工作原理

```
一轮对话结束（turn/end, completed）
  ├─ 收集这一轮：用户消息 + 助手回复 + 工具调用清单
  ├─ 调当前默认模型，写成一段叙述式记录（第一人称复数，120~220 字）
  └─ 追加进 <root>/<工作区>/<对话标题>.json
```

模型只被允许写「动作清单」里出现过的操作，降低胡编的概率；模型不可用时退回原文摘要，记录不会丢。

## 安装

在你的 profile 目录安装（DSH 桌面版请用 GUI 里的插件管理，或 `plugin_manager` 工具）：

```bash
dsh plugin --profile <你的profile> add <本仓库路径或包名>
```

装好后插件会自动进入 `dsh.profile.bundles`，重启 DSH 生效。

## 配置

三处可以改，优先级从高到低：

| 位置 | 说明 |
|---|---|
| 界面「插件 → 工作记录」 | 输入框改根目录，保存即生效，值写入 `$DSH_HOME/work-log/config.json` |
| 本插件 `cordis.patch.yml` 的 `config` | 默认值 |
| 环境变量 `DSH_HOME` | 决定上面那个 config.json 在哪 |

字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| `root` | `E:\DSH-WorkLogs` | 日志根目录 |
| `enabled` | `true` | 关闭后不再写新记录，已有文件不动 |
| `summarize` | `true` | 关掉就记原文摘要，省一次模型调用 |

## 文件结构

```
<root>/
└── <工作区目录名>/          # 会话 cwd 的目录名
    └── <对话标题>.json      # 一个对话一个文件
```

同一个标题属于不同会话时，文件名会带 `-<短id>` 后缀，不会互相覆盖；标题后来才生成的话，文件会改名跟随。

## 记录格式

```json
{
  "generator": "dsh-work-log",
  "workspace": "deepseek harness",
  "cwd": "E:\\deepseek harness",
  "conversation": "DSH插件更新报错排查",
  "sessionId": "session-...",
  "createdAt": "2026-11-06 19:32:22",
  "updatedAt": "2026-11-06 20:05:10",
  "records": [
    {
      "index": 1,
      "time": "2026-11-06 19:32:22",
      "turn": 14,
      "content": "你让我把工作日志插件的行为和配置方式摸清楚……",
      "actions": ["write E:\\deepseek harness\\dsh-plugins\\work-log\\index.js", "pwsh node --check"]
    }
  ]
}
```

- `index`：该对话内的自增序号（1、2、3…）
- `time`：记录时间
- `turn`：DSH 的轮次号
- `content`：给模型看的叙述式记录
- `actions`：这一轮实际调用过的工具（可选，旧记录没有）

## 已知限制

- 只记 `turn/end` 且 `reason: completed` 的轮次；中途被打断的不记
- 子代理会话（`origin: subagent`）不记，避免刷屏
- 每轮多一次小模型调用（约 4k 字符输入），嫌费就关 `summarize`
- 摘要质量取决于当前默认模型

## License

MIT
