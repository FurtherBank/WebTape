# WebTape — 让网页自动化像录屏一样简单

**WebTape** 是一个命令行工具，配合同名 Chrome 扩展，能将你在浏览器里的日常操作**自动转化为可直接运行的自动化脚本**，无需逆向工程，无需研究 Open API。

核心技术路径：用 Chrome 扩展录制操作与接口 → CLI 接收并保存录制数据 → AI 分析接口链路 → 生成可集成的 `request.js` 脚本。

---

## 🚀 核心价值：录制即自动化

只要你在浏览器里能做的操作，WebTape 就能帮你把它变成可以反复、自动调用的函数——**不限于网站 Open API，不需要手动抓包**。

- **免去逆向工程**：AI 自动梳理接口调用链路及参数流转关系
- **复用浏览器登录态**：自动获取本机 Chrome 的 Cookie，个人场景下无需额外登录
- **直接集成**：生成的函数可立即导入你的工具、爬虫或 AI Agent

---

## 🛠️ 快速上手

### 第一步：安装 CLI

```bash
npm install -g webtape
```

### 第二步：注册 Native Messaging（一次性）

让扩展能直接将录制数据推送到本机 CLI，无需手动配置端口：

```bash
webtape install
```

### 第三步：安装 Chrome 扩展（配套录制工具）

1. 打开 Chrome 导航到 `chrome://extensions`
2. 开启**开发者模式**（右上角开关）
3. 点击**加载已解压的扩展程序**，选择 `packages/webtape-recorder` 目录

或直接从 [GitHub Releases](https://github.com/FurtherBank/WebTape/releases) 下载最新 ZIP，按同样方式加载。

### 第四步：录制并分析

在浏览器中点击 WebTape 扩展图标 → 开始录制 → 完成操作 → 停止导出。录制数据自动推送到本机工作区。

然后运行 AI 分析：

```bash
webtape analyze <session-name>
```

---

## 🔧 工作原理

| 阶段 | 工具 | 操作 |
|------|------|------|
| 录制 | Chrome 扩展（webtape-recorder） | 捕获用户操作 + 全量网络请求（含 SSE / WebSocket） |
| 传输 | Native Messaging / Webhook | 录制数据实时或完成后推送到本机 |
| 存储 | webtape CLI | 结构化保存到本地工作区 `recordings/` |
| 分析 | webtape CLI + AI | 梳理接口依赖，生成 `request.js` 自动化脚本 |

---

## 📦 录制数据格式（ZIP 结构）

```
webtape_<timestamp>.zip
├── index.json          # 时间线骨架 + A11y 操作摘要（meta + timeline）
├── requests/           # 完整请求体（按 req_id 分类）
└── responses/          # 完整响应体，支持 HTTP / SSE / WebSocket 三种格式
```

响应文件包含 `type` 字段区分协议：`"http"` / `"sse"` / `"websocket"`，SSE 和 WebSocket 以数组记录每条消息的时间戳和方向。

---

## ✨ 扩展录制能力

`webtape-recorder` 扩展负责采集端的数据质量，核心技术特性：

- **A11y 驱动的 DOM 快照** — 使用 Chrome 无障碍树替代原始 HTML，大幅减少 AI 分析的 Token 消耗
- **滑动窗口请求归因** — 自动将网络调用与触发它的用户操作关联，还原完整操作-接口对应关系
- **SSE 捕获** — 通过 CDP `Network.eventSourceMessageReceived` 精准捕获每条 SSE 事件（含时间戳、事件名、ID、数据）
- **WebSocket 捕获** — 通过 CDP WebSocket 事件捕获握手、收发帧及连接生命周期
- **刷新并录制** — 支持从页面加载初始化阶段开始录制，捕获完整初始化接口链路
- **外部链接一键启动** — 通过 `chrome-extension://…` 链接无需手动点击即可触发录制并自动导出

---

## 🔗 外部链接一键录制

在终端、脚本或文档中配置同一条链接，交给 Chrome 打开即可自动完成「打开页面 → 录制 → 导出」全流程：

```text
chrome-extension://jcbbpjhckcknopggkbafcjnnhddjpfhm/record-launcher.html?url=https%3A%2F%2Fexample.com&export=webhook&webhook=http%3A%2F%2Flocalhost%3A5643%2Fwebhook
```

省略 Webhook 参数则沿用插件当前导出方式（下载 ZIP）。

---

## 📁 项目结构

| 包 | 路径 | 职责 |
|---|---|---|
| webtape（CLI） | `packages/webtape-cli/` | 主产品：接收录制数据、AI 分析、脚本生成 |
| webtape-recorder（扩展） | `packages/webtape-recorder/` | 配套采集工具：录制操作与接口数据并导出 |

👉 详细 CLI 用法与配置见 [packages/webtape-cli/README.md](./packages/webtape-cli/README.md)

---

## 📄 开源协议

基于 **MIT** 协议开源。
