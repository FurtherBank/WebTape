# webtape-receiver

接收 [WebTape](https://github.com/FurtherBank/WebTape) Chrome 插件的 webhook 数据，保存录制内容并通过 AI 分析业务接口链路。

## 安装

```bash
npm install -g webtape-receiver
```

## 快速开始

```bash
# 启动 webhook 接收服务器
webtape-receiver serve

# 在 WebTape 插件中将 webhook URL 设置为:
# http://localhost:5643/webhook
```

## 命令

### `serve` — 启动 webhook 接收服务器

```bash
webtape-receiver serve [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-p, --port <number>` | 监听端口 | `5643` |
| `-w, --workspace <path>` | 工作区路径 | `~/Desktop/WebTape` |
| `--no-auto-analyze` | 接收数据后不自动运行 AI 分析 | — |
| `--backend <name>` | AI 分析后端 | `cursor` |
| `--model <name>` | AI 模型名称（例如 `kimi-k2.5`） | — |

示例:

```bash
webtape-receiver serve -p 8080 --model kimi-k2.5
webtape-receiver serve --no-auto-analyze
```

### `list` — 列出所有录制会话

```bash
webtape-receiver list [-w <path>]
```

### `analyze` — 对指定会话运行 AI 分析

```bash
webtape-receiver analyze <session> [options]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-w, --workspace <path>` | 工作区路径 | `~/Desktop/WebTape` |
| `--backend <name>` | AI 分析后端 | `cursor` |
| `--model <name>` | AI 模型名称 | — |
| `--prompt-only` | 仅生成提示词文件，不执行分析 | `false` |

示例:

```bash
webtape-receiver analyze 2024-01-14_12-45-30 --model kimi-k2.5
webtape-receiver analyze 2024-01-14_12-45-30 --prompt-only
```

## 工作区目录结构

```
~/Desktop/WebTape/
├── recordings/
│   └── 2024-01-14_12-45-30/
│       ├── index.json          # 操作时间线和上下文
│       ├── meta.json           # 元数据（时间戳、版本、来源）
│       ├── prompt.md           # AI 分析提示词
│       ├── requests/           # 请求详情
│       │   ├── req_0001_body.json
│       │   └── ...
│       └── responses/          # 响应详情
│           ├── req_0001_res.json
│           └── ...
└── analyses/
    └── 2024-01-14_12-45-30.md  # AI 分析报告
```

## HTTP API

服务器启动后提供以下 HTTP 端点:

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` 或 `/health` | 健康检查 |
| `POST` | `/` 或 `/webhook` | 接收 WebTape webhook 数据 |
| `POST` | `/analyze/<session>` | 触发指定会话的 AI 分析 |
| `POST` | `/prompt/<session>` | 生成提示词文件 |

## 分析流程

1. WebTape 插件录制用户操作和网络请求
2. 插件通过 webhook 将数据发送到 receiver 服务器
3. Receiver 将录制数据保存为结构化文件，同时生成 `prompt.md` 分析提示词
4. 自动或手动触发 AI 分析（通过 Cursor Agent CLI）
5. 分析报告保存到 `analyses/` 目录

实际调用的 Cursor 命令:

```bash
cursor agent prompt "请阅读当前目录下的 prompt.md 文件..." --model "kimi-k2.5"
```

## License

ISC
