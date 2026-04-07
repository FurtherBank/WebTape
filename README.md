# WebTape — 网页操作录制器

一个面向**开发者**的 Chrome 浏览器扩展，能够：

- 按时间顺序录制网页的**用户操作**、**网络请求**和**页面内容快照**
- 将所有录制内容以**结构化、便于 LLM 分析的形式**导出（Native Messaging 或 ZIP）

导出的内容适用于以下**开发与测试**场景：

- **接口链路分析**：理清前端与后端接口的调用顺序和参数流转关系
- **开发调试**：在开发或测试自己负责的系统时，快速捕获业务流程的完整上下文

> **使用前提**：请确保你对录制的目标网站拥有合法的访问和操作权限，并遵守其服务条款。

---

### 🚀 核心配套：WebTape CLI

**让接口调试和自动化测试像录屏一样直观。**

WebTape 插件配合 CLI，可将你在**自己负责的**页面上的操作，转化为结构化的接口上下文，供 AI 分析、生成可运行的测试脚本。

- **录制即上下文**：自动关联操作与接口调用，生成完整的业务流程文档。
- **减少手动整理**：自动梳理接口调用链路及参数流转关系，代替手动抓包分析。
- **集成友好**：生成的接口函数可集成到你自己的测试工具或 AI Agent 中。

👉 [了解更多关于 WebTape CLI 的核心价值与用法](./packages/webtape-cli/README.md)

---

## 特性

- **直接录制 (Direct Record)** — 立即捕获当前页面状态，录制接下来的操作和接口数据。
- **刷新并录制 (Refresh & Record)** — 刷新页面，完整录制初始化加载流程及后续操作。
- **停止并分析 (Stop & Analyze)** — 结束会话，通过 Native Messaging 发送到本地 CLI 进行 AI 分析。
- **A11y 驱动的 DOM** — 使用 Chrome 无障碍树（Accessibility Tree）代替原始 HTML，减少 AI 分析的 Token 消耗。
- **滑动窗口请求归因** — 自动将网络调用与触发它们的用户操作关联起来。
- **层级化导出结构** — `index.json`（骨架 + A11y 摘要）+ `requests/` + `responses/`，结构清晰，适合 AI 逐层分析。
- **SSE 捕获** — 通过 CDP `Network.eventSourceMessageReceived` 捕获带时间戳的 SSE 事件流。
- **WebSocket 捕获** — 通过 CDP WebSocket 事件捕获握手、收发帧及连接生命周期。

---

## 导出数据结构

```
webtape_<timestamp>.zip
│
├── index.json              # 第 1 层 — { meta, timeline }：meta 含版本与录制起止时间，timeline 为时间线骨架
├── requests/               # 第 2 层 — 完整请求体（按 req_id 归档）
│   └── req_0001_<ts>_body.json
└── responses/              # 第 2 层 — 完整响应体（按 req_id 归档）
    └── req_0001_<ts>_res.json
```

### 响应格式

**HTTP** (`type: "http"`):
```json
{
  "req_id": "req_0001_...",
  "type": "http",
  "status": 200,
  "headers": { "...": "..." },
  "mime_type": "application/json",
  "body": { "key": "value" }
}
```

**SSE** (`type: "sse"`):
```json
{
  "req_id": "req_0002_...",
  "type": "sse",
  "status": 200,
  "body": [
    { "timestamp": 1705333845.123, "event": "message", "id": "1", "data": "..." }
  ]
}
```

**WebSocket** (`type: "websocket"`):
```json
{
  "req_id": "req_0003_...",
  "type": "websocket",
  "status": 101,
  "body": [
    { "timestamp": 1705333845.123, "direction": "sent", "opcode": 1, "data": "..." }
  ]
}
```

---

## 安装

### 从 Chrome Web Store 安装（推荐）

> 即将上线，敬请期待。

### 从源码构建

```bash
git clone https://github.com/FurtherBank/WebTape.git
cd WebTape
npm install
cd packages/webtape-recorder
npm install
npm run build   # 输出 dist/webtape.zip
```

加载扩展：打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `packages/webtape-recorder` 目录。

---

## 使用方法

1. 点击工具栏中的 WebTape 图标。
2. 导航到你**有权限**录制的目标页面。
3. 点击 **Direct Record**（或 **Refresh & Record** 以捕获完整页面加载过程）。
4. 正常与页面交互。
5. 点击 **Stop & Analyze** — 录制数据将通过 Native Messaging 发送至本地 CLI 进行 AI 分析。

---

## 外部链接一键录制

在终端、文档或快捷方式中配置 `chrome-extension://…` 链接，Chrome 打开后可自动完成：打开目标页 → 录制 → 自动结束并发送数据至 CLI。

**链接模板示例**（目标为 `https://your-own-site.com`）：

```text
chrome-extension://jcbbpjhckcknopggkbafcjnnhddjpfhm/record-launcher.html?url=https%3A%2F%2Fyour-own-site.com
```

Popup 中的「复制外部启动页模板」按钮可生成当前格式的链接，便于核对参数。

👉 工作区目录、分析开关与 CLI 详细用法见 [WebTape CLI](./packages/webtape-cli/README.md)。

---

## 架构设计

| 模块 | 位置 | 职责 |
|---|---|---|
| UI & 控制 | `src/popup.js` | 用户控制界面、状态显示 |
| CDP 嗅探器 | `src/background.js` | `chrome.debugger` 的附加/分离，Network 和 Accessibility CDP 域处理 |
| 操作捕获 | `src/content.js` | DOM 事件监听器 → 发送操作消息 |
| 聚合引擎 | `src/background.js` | 滑动窗口上下文匹配 |
| 导出模块 | `src/background.js` | 数据序列化，通过 Native Messaging 发送至 CLI |
| 外部启动 | `src/record-launcher.js` | 解析链接参数并启动录制 |

---

## 发布新版本

```bash
git tag v1.x.x
git push origin v1.x.x
```

触发 GitHub Actions 自动构建 `webtape-v1.x.x.zip` 并创建 Release。详见 [上线流程文档](./docs/chrome-store-publish-guide.md)。

---

## 📄 开源协议

基于 **PolyForm Noncommercial 1.0.0** 协议开源。允许个人学习、研究和非商业用途自由使用；**商业用途需取得授权**。详见 [LICENSE](./LICENSE)。
