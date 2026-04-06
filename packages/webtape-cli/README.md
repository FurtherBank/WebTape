# WebTape CLI — 让网页自动化像录屏一样简单

**WebTape CLI**（npm 包名 `webtape`）是 WebTape 产品的核心主入口。

它接收来自 [webtape-recorder](../webtape-recorder/) Chrome 扩展的录制数据，借助 AI 深度分析网页操作背后的完整接口链路，最终生成**可直接运行、不依赖网站 Open API 和手动浏览器操作**的自动化脚本。

---

## ✨ 核心价值：录制即自动化集成

只要你在浏览器里能做的操作，WebTape 就能把它变成随时可以调用的函数：

- **免去逆向工程** — AI 自动梳理接口间调用链路，及输入输出过程中参数字段的流转关系
- **复用浏览器登录态** — 自动获取本机 Chrome 的 Cookie，个人场景下无需额外登录
- **不限 Open API** — 只要日常浏览器能通的接口，自动化都能通
- **直接集成** — 生成的 `request.js` 函数可立即导入你的工具、爬虫或 AI Agent

无论是获取私有接口数据，还是执行复杂的业务流程，都能像调用本地函数一样简单。

---

## 🛠️ 快速上手

### 第一步：安装

> 如果还没有安装 Node.js，请先参考 [Node.js 安装指南](https://nodejs.org/zh-cn/download/package-manager)。

```bash
npm install -g webtape
```

### 第二步：注册 Native Messaging（一次性初始化）

让 Chrome 扩展能直接将录制数据推送到本机 CLI，无需手动管理端口：

```bash
webtape install
```

CLI 按固定插件 ID `jcbbpjhckcknopggkbafcjnnhddjpfhm`（与 `webtape-recorder/manifest.json` 中 `key` 一致）注册 Native Messaging Host，**无需**额外传参。

### 第三步：录制

安装并启动 [webtape-recorder](../webtape-recorder/) Chrome 扩展，在目标页面点击「开始录制」→ 完成操作 → 「停止导出」。录制数据自动传入本机工作区。

### 第四步：AI 分析

```bash
webtape analyze <session-name>
```

AI 自动梳理接口依赖并在工作区生成 `analysis_report.md` 和 `request.js`，直接集成使用。

---

## 🔧 技术架构：与扩展的通信方式

CLI 与 Chrome 扩展之间通过两种通道互通，**无需用户手动启动服务**：

| 通道 | 场景 | 说明 |
|------|------|------|
| **Native Messaging** | 主要通道 | 扩展停止录制后，Chrome 自动按需 spawn `webtape` 进程处理数据 |
| **Webhook** | 备选通道 | 运行 `webtape serve`，扩展将数据推送到 `http://localhost:5643/webhook` |

**Native Messaging 是推荐用法**：一次注册，后续录制自动触发，无需常驻服务进程。

---

## 📂 工作区结构

运行任意 `webtape` 命令后，自动在桌面创建 `WebTape/` 工作区：

```
~/Desktop/WebTape/
├── recordings/         # 所有录制会话（按时间戳命名）
│   └── <session>/
│       ├── index.json        # 时间线骨架 + 操作摘要
│       ├── requests/         # 完整请求体
│       └── responses/        # 完整响应体（HTTP / SSE / WebSocket）
├── AGENTS.md           # 内置 AI 分析规则（供 Cursor 等 AI 工具使用）
├── package.json        # Node 环境（生成的脚本开箱即用）
└── scripts/
    └── quicktype-res.mjs   # 大响应体类型生成工具
```

---

## 📋 命令参考

| 命令 | 说明 |
|------|------|
| `webtape install` | 注册 Native Messaging Host（一次性） |
| `webtape serve` | 启动 Webhook 接收服务器（默认 5643 端口） |
| `webtape list` | 列出所有录制会话 |
| `webtape analyze <session>` | AI 分析指定会话，生成报告和脚本 |
| `webtape config` | 交互式配置向导 |

### 常用选项

| 命令 | 选项 | 说明 |
|------|------|------|
| `install` | `--no-open` | 不自动打开 Chrome 应用商店页 |
| `serve` | `-p, --port` | 监听端口（默认 5643） |
| `serve` | `-w, --workspace` | 自定义工作区路径 |
| `serve` | `--backend` | AI 后端：`cursor` / `claude` / `none` |
| `analyze` | `--backend` | AI 后端（同上） |

---

## 💡 使用场景

- **数据采集** — 无需研究反爬机制，直接复用浏览器登录态获取私有接口数据
- **业务自动化** — 将重复的网页操作转化为脚本，定时运行或集成到工作流
- **AI Agent 增强** — 为 AI 助手提供直接调用真实业务接口的能力，突破 Open API 限制

---

## ⚠️ macOS 用户提示

生成的脚本通过 `chrome-cookies-secure` 获取本机 Chrome Cookie。macOS 首次运行时会弹出安全提示：

**请输入开机密码**，并选择**「始终允许」**以获得最稳定的运行体验。

---

## 📄 开源协议

基于 **MIT** 协议开源。

---

**准备好了吗？** `npm install -g webtape` 开始你的第一次自动化。
