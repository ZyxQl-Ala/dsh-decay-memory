# dsh-decay-memory

**会淡忘的记忆** —— 给 DeepSeek Harness 用的记忆插件：被提起的记忆会重新点亮，不被提起的就按照遗忘曲线慢慢变短、最后消失。

Memory that **forgets gracefully**: entries gain weight every time they are mentioned, fade and shrink when they are not, and 📌-pinned entries never decay.

> 灵感来自一张「小肥鱼大脑」的图：神经元记忆、重要的在中心、边缘的慢慢淡掉，200 天内被提起就能再次唤醒。

## 它解决什么

普通记忆插件只有「存」和「删」：要么无限膨胀占满提示词，要么一刀切地过期删除，重要的和随口一说的东西一起消失。

这个插件给每条记忆一个**强度**：

```
强度 = w × 0.5 ^ (距上次提起的天数 / 半衰期)
```

- **提起 = 点亮**：`memory_search` / `memory_add` 重复内容 / 手动 `memory_touch`，强度 +0.4（封顶 1）；
- **不提 = 淡忘**：强度低于 `fadeBelow` 时正文按比例缩短并标记「（记忆渐淡）」；低于 `dropBelow` 才真正删除；
- **📌 pin = 永远**：永久记忆强度恒为 1，永不参与淘汰；
- **上限按最弱淘汰**：超过 `maxEntries` 时先忘最弱的一条，而不是最旧的。

## 安装

```bash
dsh plugin --profile <profile> add dsh-decay-memory
```

或本地开发：

```bash
dsh plugin --profile desktop add file:D:/path/to/dsh-decay-memory
```

## 工具

| 工具 | 作用 |
|---|---|
| `memory_add` | 记一件事；相同内容会重新点亮，`pinned:true` 永久保留 |
| `memory_search` | 检索记忆（按强度+文字匹配），命中的会点亮 |
| `memory_touch` | 手动点亮某条（对话里又提到它时用） |
| `memory_forget` | 真删某条（📌 需先取消 pin） |
| `memory_pin` | 设为/取消 📌 永久记忆 |
| `memory_stats` | 查看条数、📌 数、最强/最弱几条 |

每轮会把排在前面的记忆注入系统提示词（有 `promptMaxEntries` / `promptMaxChars` 上限）。

## 配置

```jsonc
{
  "halfLifeDays": 200,      // 半衰期（天）；调小 = 忘得更快
  "fadeBelow": 0.5,         // 低于这个强度开始「渐淡」
  "dropBelow": 0.06,        // 低于这个强度真正删除
  "maxEntries": 24,         // 最多保留多少条（按最弱淘汰）
  "promptMaxEntries": 12,   // 每轮最多注入几条
  "promptMaxChars": 2000,   // 注入正文上限
  "promptEnabled": true,
  "stateFile": ""           // 默认 $DSH_HOME/decay-memory/memory.json
}
```

## 存储

默认写到 `$DSH_HOME/decay-memory/memory.json`，纯本地、无网络、无遥测。写入是「临时文件 + rename」的原子替换，不会写坏。

## License

MIT

## 设置页

插件自带一个零构建的 Web 设置页（由 host 直接提供，不依赖 client 打包）：

```
<你的 DSH 地址>/decay-memory
```

例如 `http://127.0.0.1:19387/decay-memory`（端口以 DSH 实际提示为准）。页面可以：

- 改半衰期、渐淡阈值、淘汰阈值、条数上限、注入条数与字数上限；
- 看每条记忆的**强度进度条**、上次提起时间、提起次数；
- 一键「点亮」「📌 永久」「删」，也可以手动记一条；
- 所有改动即时写回 `$DSH_HOME/decay-memory/memory.json`。

数据接口（同源、需要 DSH 登录态）：

```
GET  /decay-memory/api/state
POST /decay-memory/api/config   { halfLifeDays, fadeBelow, ... }
POST /decay-memory/api/action   { op: "add" | "touch" | "pin" | "forget", ... }
```
