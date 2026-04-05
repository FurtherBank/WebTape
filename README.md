# WebTape — 网页操作录制器

一个 Chrome 浏览器扩展，能够：
- 通过录制过程，按照时间顺序记录网页的**用户操作**、**网络请求**和**页面内容快照**
- 并将所有录制内容以**结构化、便于 LLM 分析的形式**，走 zip 或 WebHook 形态导出

导出的内容可适用于以下 LLM 驱动的分析场景：
- 网页接口交互链路分析
- 前端开发过程中，捕捉业务流程交互情况进行 Debug

---

### 🚀 核心配套：WebTape Receiver (CLI)

**让网页自动化像录屏一样简单。**

WebTape 插件配合 Receiver CLI，能将你在浏览器中的操作，瞬间转化为可直接运行且**不依赖网站 Open API**的自动化脚本。

- **录制即自动化**：配合 AI 分析，直接理解网页操作并生成可运行的 `request.js` 脚本。
- **免去逆向工程**：自动处理 Cookie、梳理接口调用链路及参数流转。
- **无缝集成**：生成的函数可快速集成到你的工具、爬虫或 AI Agent 中。

👉 [了解更多关于 WebTape CLI 的核心价值与用法](./packages/webtape-cli/README.md)

---
## WIP 视频演示

### 1. 插件录制演示 (Bilibili 场景)
*展示如何通过插件捕获网页交互与完整接口链路。*

| 步骤 | 操作 | 画面重点 |
| :--- | :--- | :--- |
| **1. 准备** | 打开 Chrome 进入目标页面，点击 WebTape 图标。 | 插件 Popup 界面弹出，显示 "Ready"。 |
| **2. 开始** | 点击 **"Refresh & Record"**。 | 页面自动刷新，插件开始记录初始化加载及后续操作。 |
| **3. 交互** | 正常进行网页交互（如点赞、评论、翻页）。 | WebTape 静默记录所有点击事件和背后的 API 请求。 |
| **4. 导出** | 点击 **"Stop & Export"**。 | 自动下载包含完整 A11y 树和请求链路的 ZIP 包。 |

### 2. 自动化闭环演示 (从录制到脚本生成)
*配合 WebTape Receiver，将录制内容瞬间转化为可运行的 JS 脚本。*

1. **启动 CLI**: `webtape serve` 开启 Webhook 接收。
2. **实时同步**: 插件录制完成后，数据自动同步至本地工作区。
3. **AI 分析**: 运行 `analyze` 命令，AI 自动梳理接口依赖并生成 `request.js`。
4. **一键运行**: 直接调用生成的函数，实现业务自动化。

## 特性

- **直接录制 (Direct Record)** — 立即捕获当前页面状态，并录制接下来的页面操作和接口数据。
- **刷新并录制 (Refresh & Record)** — 刷新页面，并录制网站初始化流程，以及接下来的页面操作和接口数据。
- **停止并导出 (Stop & Export)** — 结束会话，并以 Zip 或 WebHook 方式导出录制数据。
- **A11y 驱动的 DOM** — 使用 Chrome 的无障碍树（Accessibility Tree）代替原始 HTML，以最大限度减少 AI 分析的 Token 消耗。
- **滑动窗口请求归因** — 自动将网络调用与触发它们的用户操作关联起来。
- **层级化 ZIP 结构** — 包含 `index.json`（骨架 + A11y 摘要）以及 `requests/` 和 `responses/` 文件夹，避免 AI 直接分析击穿上下文。
- **SSE (Server-Sent Events) 捕获** — 通过 CDP `Network.eventSourceMessageReceived` 捕获带有时间戳、事件名称、ID 和数据的单个 SSE 事件。
- **WebSocket 捕获** — 通过 CDP WebSocket 事件捕获 WebSocket 握手、发送/接收的帧以及连接生命周期。

## ZIP 输出结构

```
webtape_<timestamp>.zip
│
├── index.json              # 第 1 层 – { meta, timeline }：meta 含版本与录制起止时间（CST + epoch_ms），timeline 为时间线骨架
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
5. 点击 **加载已解压的扩展程序** 并选择目录 **`packages/webtape-recorder`**（内含带固定 `key` 的 `manifest.json`，扩展 ID 与 CLI 一致）。

## 使用方法

1. 点击 WebTape 工具栏图标。
2. 导航到你想要录制的页面。
3. 点击 **Direct Record**（或点击 **Refresh & Record** 以捕获完整的页面加载过程）。
4. 正常与页面进行交互。
5. 点击 **Stop & Export** — ZIP 文件将自动开始下载。

## 浏览器外一键录制（一条链接）

在终端、自动化脚本、文档或快捷方式里配置**同一条** `chrome-extension://…` 链接，交给 Chrome 打开后，即可在**无需先手动点开插件**的情况下：打开目标页 → 按「刷新并录制」等价策略采集页面加载与接口 → **自动结束并导出**。与 **WebTape Receiver** 合用时，链接里指明 Webhook 后，产物会进入本机工作区；Receiver 可按你的配置**在收到数据后自动做接口分析**（或仅保存，由你稍后分析）。

### 链接模板

示例（目标 `https://example.com`，Webhook 为本机 Receiver 默认地址）：

```text
chrome-extension://jcbbpjhckcknopggkbafcjnnhddjpfhm/record-launcher.html?url=https%3A%2F%2Fexample.com&export=webhook&webhook=http%3A%2F%2Flocalhost%3A5643%2Fwebhook
```

Popup 里的「复制外部启动页模板」生成的是同一套链接，便于核对扩展 ID 与参数格式。若省略 Webhook 相关参数，则沿用插件当前导出方式（例如下载 ZIP）。单次触发的录制时长与结束时机由扩展自动处理，无需再点停止。

👉 工作区目录、分析开关与 CLI 用法见 [WebTape CLI](./packages/webtape-cli/README.md)。

## 架构设计

| 模块 | 位置 | 职责 |
|---|---|---|
| UI & 控制 | `popup.html` / `popup.js` | 用户控制界面、状态显示 |
| CDP 嗅探器 | `background.js` | `chrome.debugger` 的附加/分离，Network 和 Accessibility CDP 域处理 |
| 操作捕获 | `content.js` | DOM 事件监听器 → 发送操作消息 |
| 聚合引擎 | `background.js` | 滑动窗口上下文匹配 |
| 导出模块 | `background.js` | JSZip 打包，触发 `chrome.downloads` |
| 外部启动 | `record-launcher.html` / `record-launcher.js` | 解析链接参数并启动录制 |

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
record-launcher.html / record-launcher.js  外部链接启动录制
lib/
  jszip.min.js     内置的 JSZip 库
icons/
  icon{16,32,48,128}.png  扩展图标
packages/
  webtape-cli/           CLI Webhook 接收器 & AI 分析器
  webtape-recorder/      Chrome 扩展插件源码
```

## WebTape CLI

`webtape` 是一个命令行工具，用于接收 WebTape 插件通过 Webhook 发送的录制数据，并借助 AI 工具分析网页业务逻辑的完整接口链路。

### 安装

```bash
cd packages/webtape-cli
npm install
npm run build
```

### 使用

**启动服务器**（默认在 `~/Desktop/WebTape` 创建工作区，监听 5643 端口）：

```bash
npx webtape serve
```

在 WebTape 插件设置中将导出模式改为 Webhook，URL 填写 `http://localhost:5643/webhook`。

**列出录制会话**：

```bash
npx webtape list
```

**AI 分析**（通过 Cursor Agent）：

```bash
npx webtape analyze <session-name>
```

### CLI 选项

| 命令 | 选项 | 说明 |
|------|------|------|
| `install` | `--no-open` | 注册 Native Messaging Host；默认打开网上应用店页 |
| `serve` | `-p, --port` | 监听端口（默认 5643） |
| `serve` | `-w, --workspace` | 工作区路径 |
| `serve` | `--backend` | AI 后端（cursor / claude / none） |
| `analyze` | `--backend` | AI 后端 |
| `config` | — | 交互式配置向导 |

插件扩展 ID 固定为 `jcbbpjhckcknopggkbafcjnnhddjpfhm`（与 `manifest.json` 中 `key` 对应），`webtape install` 不再接受 `--extension-id`。

---

## 📄 开源协议

基于 **MIT** 协议开源。

