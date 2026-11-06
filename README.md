# ocs-ai-relay

给 [OCS 网课助手](https://docs.ocsjs.com/) 之类只认「题库配置」的用户脚本，接上任意 **OpenAI 兼容**大模型接口的本地中转。

> 一句话：脚本 -> `http://127.0.0.1:8787/v1/chat/completions` -> 你的模型服务。

## 为什么需要它

| 痛点 | 这个中转怎么解决 |
| --- | --- |
| 用户脚本有 `@connect` 白名单，外部 API 域名被拦 | 中转跑在 `127.0.0.1`，天然在白名单里 |
| 推理模型偶尔吃掉全部 token，返回空内容 | 自动翻倍 `max_tokens` 重试，必要时从 reasoning 里兜底提取 |
| 判断题选项是「对/错」，模型却回字母 A/B | 自动识别判断题，把字母映射回选项文字 |
| 模型答不出需要查资料的新题 | Bing 搜索取摘要，作为参考资料二次提问 |
| 想改 key/模型/搜索策略要翻配置文件 | 自带网页控制台，填 URL 和 Key 就能用 |

## 快速开始

```bash
git clone <repo-url> ocs-ai-relay
cd ocs-ai-relay
node relay.js
```

打开 <http://127.0.0.1:8787/>，在控制台里填：

- **上游地址**：你的 OpenAI 兼容接口根地址，例如 `https://api.example.com`（不要带 `/v1/chat/completions`）
- **API Key**：上游的密钥
- **搜索模式**：`always`（每题都搜）/ `fallback`（答不出来才搜）/ `off`

点「保存」，再点「测试连通性」确认能通。

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

> `handler` 必须返回 `[问题, 答案, 附加数据]` —— 答案在第 2 位，这是 OCS 题库解析器的约定。
>
> Key 可以只填在中转的控制台里，脚本的 `headers` 里不必带 `Authorization`。

## 控制台

| 能力 | 说明 |
| --- | --- |
| 上游地址 / Key / 模型覆盖 | 保存到 `config.json`，立即生效，无需重启 |
| 搜索模式 / 条数 | `always`、`fallback`、`off` |
| 判断题映射 | 关闭后字母答案原样透传 |
| 测试连通性 | 服务端真实发一次请求，返回状态码与耗时 |
| 运行统计 | 总请求、失败数、搜索命中、平均耗时、最近失败 |
| 最近请求 | 时间、状态、耗时、题目、答案 |

配置文件位置：项目根目录 `config.json`（已在 `.gitignore` 中，不会提交）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI 兼容入口（兼容 `stream: false`） |
| GET | `/health` | 健康检查 |
| GET | `/api/config` | 读取配置（Key 打码） |
| POST | `/api/config` | 更新配置（Key 传空则保留原值） |
| POST | `/api/test` | 用当前配置测试上游 |
| GET | `/api/stats` | 汇总统计 |
| GET | `/api/logs?n=50` | 最近请求明细 |
| GET | `/search?q=...` | 手动试搜索 |

## 安全

- 默认只监听 `127.0.0.1`，不要把它暴露到公网。
- Key 以明文存于本机 `config.json`，请勿提交、勿分享。
- 搜索摘要来自第三方搜索引擎，属于不可信内容，仅作参考资料。

## 测试

```bash
npm test
```

测试会启动一个假的模型上游，覆盖：配置读写、判断题映射、HTML 解析、重试、端到端请求。

## License

[MIT](./LICENSE)
