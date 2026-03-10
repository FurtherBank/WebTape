# WebTape — 网页操作录制器

一个 Chrome 浏览器扩展（Manifest V3），能够静默记录用户交互、网络请求和无障碍树（Accessibility Tree）快照，并将所有内容导出为结构化的 ZIP 文件，用于 LLM 驱动的分析和代码生成。

## 特性

- **直接录制 (Direct Record)** — 立即附加调试器，捕获当前页面状态。
- **刷新并录制 (Refresh & Record)** — 附加调试器后重新加载页面，捕获完整的初始化流程。
- **停止并导出 (Stop & Export)** — 结束会话并自动下载分层结构的 ZIP 归档文件。
- **A11y 驱动的 DOM** — 使用 Chrome 的无障碍树（Accessibility Tree）代替原始 HTML，以最大限度减少 Token 消耗。
- **滑动窗口请求归因** — 自动将网络调用与触发它们的用户操作关联起来。
- **层级化 ZIP 结构** — 包含 `index.json`（骨架 + A11y 摘要）以及 `requests/` 和 `responses/` 文件夹。
- **SSE (Server-Sent Events) 捕获** — 通过 CDP `Network.eventSourceMessageReceived` 捕获带有时间戳、事件名称、ID 和数据的单个 SSE 事件。
- **WebSocket 捕获** — 通过 CDP WebSocket 事件捕获 WebSocket 握手、发送/接收的帧以及连接生命周期。

---

### 🚀 核心配套：WebTape Receiver (CLI)

**让网页自动化像录屏一样简单。**

WebTape Receiver 是 WebTape 生态中的核心动力引擎，它能将你在浏览器中的操作，瞬间转化为可直接运行且**不依赖网站 Open API** 的自动化脚本。

- **录制即自动化**：配合 AI 分析，直接理解网页操作并生成可运行的 `request.js` 脚本。
- **免去逆向工程**：自动处理 Cookie、梳理接口调用链路及参数流转。
- **无缝集成**：生成的函数可快速集成到你的工具、爬虫或 AI Agent 中。

👉 [了解更多关于 WebTape Receiver 的核心价值与用法](./packages/webtape-receiver/README.md)

---

## ZIP 输出结构

```
webtape_<timestamp>.zip
│
├── index.json              # 第 1 层 – AI 可读的时间线骨架
├── requests/               # 第 2 层 – 完整请求体（按 req_id 分类）
│   └── req_0001_<ts>_body.json
└── responses/              # 第 2 层 – 完整响应体（按 req_id 分类）
    └── req_0001_<ts>_res.json
```

### 响应格式类型

每个响应文件夹包含一个 `type` 字段，指示所使用的协议：

**HTTP** (`type: "http"`):
```json
{
  "req_id": "req_0001_...",
  "type": "http",
  "status": 200,
  "headers": { ... },
  "mime_type": "application/json",
  "body": "{ \"key\": \"value\" }"
}
```

**SSE** (`type: "sse"`):
```json
{
  "req_id": "req_0002_...",
  "type": "sse",
  "status": 200,
  "headers": { ... },
  "mime_type": "text/event-stream",
  "body": [
    { "timestamp": 1705333845.123, "event": "message", "id": "1", "data": "..." },
    { "timestamp": 1705333845.456, "event": "update", "id": "2", "data": "..." }
  ]
}
```

**WebSocket** (`type: "websocket"`):
```json
{
  "req_id": "req_0003_...",
  "type": "websocket",
  "status": 101,
  "headers": { ... },
  "body": [
    { "timestamp": 1705333845.123, "direction": "sent", "opcode": 1, "data": "..." },
    { "timestamp": 1705333845.456, "direction": "received", "opcode": 1, "data": "..." }
  ]
}
```

## 安装

### 从源码安装

1. 克隆仓库。
2. 安装依赖（会将 `jszip.min.js` 复制到 `lib/` 目录）：
   ```bash
   npm install
   ```
3. 打开 Chrome 浏览器并导航至 `chrome://extensions`。
4. 开启 **开发者模式** (右上角开关)。
5. 点击 **加载已解压的扩展程序** 并选择仓库根目录。

## 使用方法

1. 点击 WebTape 工具栏图标。
2. 导航到你想要录制的页面。
3. 点击 **Direct Record**（或点击 **Refresh & Record** 以捕获完整的页面加载过程）。
4. 正常与页面进行交互。
5. 点击 **Stop & Export** — ZIP 文件将自动开始下载。

## 架构设计

| 模块 | 位置 | 职责 |
|---|---|---|
| UI & 控制 | `popup.html` / `popup.js` | 用户控制界面、状态显示 |
| CDP 嗅探器 | `background.js` | `chrome.debugger` 的附加/分离，Network 和 Accessibility CDP 域处理 |
| 操作捕获 | `content.js` | DOM 事件监听器 → 发送操作消息 |
| 聚合引擎 | `background.js` | 滑动窗口上下文匹配 |
| 导出模块 | `background.js` | JSZip 打包，触发 `chrome.downloads` |

## 发布

若要发布新版本，请向 `main` 分支推送版本标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

这将触发 GitHub Actions 工作流，构建扩展包并创建一个带有 `webtape-v1.0.0.zip` 产物的 GitHub Release。

## 文件概览

```
manifest.json      Chrome 扩展 Manifest V3
background.js      Service worker – CDP、聚合、导出
content.js         Content script – 操作捕获
popup.html         Popup UI 结构
popup.js           Popup 逻辑
popup.css          Popup 样式
lib/
  jszip.min.js     内置的 JSZip 库
icons/
  icon{16,32,48,128}.png  扩展图标
packages/
  webtape-receiver/      CLI Webhook 接收器 & AI 分析器
```

## WebTape Receiver (CLI)

`webtape-receiver` 是一个命令行工具，用于接收 WebTape 插件通过 Webhook 发送的录制数据，并借助 AI 工具分析网页业务逻辑的完整接口链路。

### 安装

```bash
cd packages/webtape-receiver
npm install
npm run build
```

### 使用

**启动服务器**（默认在 `~/Desktop/WebTape` 创建工作区，监听 5643 端口）：

```bash
npx webtape-receiver serve
```

在 WebTape 插件设置中将导出模式改为 Webhook，URL 填写 `http://localhost:5643/webhook`。

**列出录制会话**：

```bash
npx webtape-receiver list
```

**AI 分析**（通过 Cursor Agent）：

```bash
npx webtape-receiver analyze <session-name>
```

仅生成提示词文件（手动粘贴到 Cursor Chat）：

```bash
npx webtape-receiver analyze <session-name> --prompt-only
```

### CLI 选项

| 命令 | 选项 | 说明 |
|------|------|------|
| `serve` | `-p, --port` | 监听端口（默认 5643） |
| `serve` | `-w, --workspace` | 工作区路径 |
| `serve` | `--auto-analyze` | 接收数据后自动运行 AI 分析 |
| `serve` | `--backend` | AI 后端（目前支持 `cursor`） |
| `analyze` | `--prompt-only` | 仅生成提示词文件 |
| `analyze` | `--backend` | AI 后端 |
