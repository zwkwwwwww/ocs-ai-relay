# ocs-ai-relay

给 [OCS 网课助手](https://docs.ocsjs.com/) 之类只认「题库配置」的用户脚本，接上任意 **OpenAI 兼容**大模型接口的本地中转。

> 一句话：脚本 -> http://127.0.0.1:8787/v1/chat/completions -> 你的一个或多个模型服务。

## 为什么需要它

| 痛点 | 这个中转怎么解决 |
| --- | --- |
| 用户脚本有 @connect 白名单，外部 API 域名被拦 | 中转跑在 127.0.0.1，天然在白名单里 |
| 推理模型偶尔吃掉全部 token，返回空内容 | 自动翻倍 max_tokens 重试，必要时从 reasoning 里兜底提取 |
| 判断题选项是「对/错」，模型却回字母 A/B | 自动识别判断题，把字母映射回选项文字 |
| 模型答不出需要查资料的新题 | Bing 搜索取摘要，作为参考资料二次提问 |
| 手上有多个服务商 / 本地网关，想按模型分流 | 多上游 + 模型路由（精确名与 auto/* 通配）+ 失败自动切换 |
| 想改 key / 模型 / 搜索策略要翻配置文件 | 自带网页控制台，填地址和 Key 就能用 |

## 快速开始

```bash
git clone <repo-url> ocs-ai-relay
cd ocs-ai-relay
node relay.js
```

打开 http://127.0.0.1:8787/ ，在控制台里：

1. 「上游服务」里填地址与 Key（可加多个上游，例如一个直连服务商 + 一个本地网关）
2. 「模型路由」里按模型名分流，例如 auto/* -> 本地网关
3. 「搜索与策略」里选搜索模式：always / fallback / off

点「保存并生效」，再点某个上游的「测试」确认能通。

## 接到 OCS（或任意用户脚本）

在脚本的「题库配置」里新增一项：

```json
[
  {
    "name": "local-relay",
    "type": "GM_xmlhttpRequest",
    "method": "post",
    "url": "http://127.0.0.1:8787/v1/chat/completions",
    "contentType": "json",
    "headers": { "Content-Type": "application/json" },
    "data": {
      "model": "deepseek-flash",
      "temperature": 0,
      "max_tokens": 2048,
      "messages": [
        { "role": "system", "content": "你是网课题库。单选/判断只输出选项字母，多选连写，填空只输出内容。" },
        { "role": "user", "content": "题目：${title}\n选项：${options}" }
      ]
    },
    "handler": "return (res) => ['', String((res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '').trim(), { tags: ['AI'] }];"
  }
]
```

> handler 必须返回 [问题, 答案, 附加数据] —— 答案在第 2 位，这是 OCS 题库解析器的约定。
>
> Key 只需要填在中转的控制台里，脚本的 headers 里不必带 Authorization。

## 多上游与路由

上游是一张表，routes 决定某个 model 走哪个上游：

```json
{
  "providers": {
    "direct": { "upstream": "https://api.example.com", "apiKey": "sk-xxx", "enabled": true },
    "local":  { "upstream": "http://127.0.0.1:3425",  "apiKey": "local", "enabled": true }
  },
  "defaultProvider": "local",
  "routes": [
    { "model": "auto/*",  "provider": "local" },
    { "model": "group/*", "provider": "local" },
    { "model": "deepseek-flash", "provider": "direct" }
  ]
}
```

匹配顺序：精确名 -> 通配符 -> 默认上游。选中的上游失败（网络错误 / 5xx）后，会按顺序自动切到其它启用的上游再试，日志里能看到 provider 字段。

## 控制台

| 能力 | 说明 |
| --- | --- |
| 上游增删改 | 每个上游独立的地址、Key、启用状态，可单独「测试」 |
| 模型路由 | 精确名或 auto/* 形式的通配规则 |
| 搜索模式 / 条数 | always、fallback、off |
| 判断题映射 | 关闭后字母答案原样透传 |
| 运行统计 | 总请求、失败数、搜索命中、平均耗时、最近失败 |
| 最近请求 | 时间、上游、状态、耗时、题目、答案（排障用） |
| 答题记录 | 每答一题的题目、选项、答案、上游、耗时，可一键导出 CSV |

配置保存在项目根目录 config.json（已在 .gitignore 中，不会提交）。保存即生效，无需重启。

## 答题记录

每答完一道题，中转会往 history.jsonl 追加一条结构化记录：

```json
{"ts":"2026-11-23T09:40:00.000Z","type":"judgement","question":"题目：光速比声速快。（）\n选项：对\n错","options":["对","错"],"answer":"对","provider":"magpie","model":"auto/*","searched":true,"judgementMapped":true,"ms":3900}
```

- type 由选项自动推断：judgement / choice / completion
- 记录只在本机，history.jsonl 与 history.csv 都已加入 .gitignore
- 控制台「答题记录」卡片可查看最近 20 条，点「导出 CSV」下载全量（带 BOM，Excel 打开中文不乱码）

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /v1/chat/completions | OpenAI 兼容入口 |
| GET | /health | 健康检查（含上游列表） |
| GET | /api/config | 读取配置（Key 打码） |
| POST | /api/config | 更新配置（Key 传空则保留原值） |
| POST | /api/test | 测试指定上游，可传 {"provider":"local"} |
| GET | /api/stats | 汇总统计 |
| GET | /api/logs?n=50 | 最近请求明细（排障日志） |
| GET | /api/history?n=50 | 答题记录（题目 / 答案 / 上游） |
| GET | /api/history.csv?n=5000 | 答题记录 CSV 下载 |
| GET | /search?q=... | 手动试搜索 |

## 安全

- 默认只监听 127.0.0.1，不要把它暴露到公网。
- Key 以明文存于本机 config.json，请勿提交、勿分享。
- 搜索摘要来自第三方搜索引擎，属于不可信内容，仅作参考资料。

## 测试

```bash
npm test
```

测试会启动假的模型上游，覆盖：配置读写与旧格式迁移、模型路由、上游故障转移、判断题映射、reasoning 兜底、HTML 解析与搜索缓存。

## License

[MIT](./LICENSE)
