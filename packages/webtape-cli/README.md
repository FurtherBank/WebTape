# 🚀 WebTape CLI：让接口调试像录屏一样直观

**WebTape CLI** 是 [WebTape](https://github.com/FurtherBank/WebTape) 生态中的核心分析引擎。

它能将你在浏览器中的操作（针对**你自己负责或有权限访问的系统**），转化为结构化的接口调用上下文，供 AI 分析并生成可复用的测试脚本。

---

## ✨ 核心价值：录制即接口文档

通过 WebTape 插件录制你的业务操作，CLI 自动接收所有网络请求，配合 AI 分析，将操作流程整理成完整的接口调用链路文档，并生成可自动化运行的 `request.js` 脚本。

其中：

- 支持复用你本机 Chrome 浏览器的登录态（Cookie），开发调试无需重复配置认证。
- AI 会深度梳理接口间的调用依赖和参数流转，帮你从手动抓包分析中解脱出来。

生成的脚本可集成到你自己的**测试工具、开发脚手架或 AI Agent** 中，实现对**你有权限操作**的系统接口的自动化调用。

> **重要**：本工具仅供对你拥有合法权限的系统进行开发、测试和自动化。请勿用于未经授权访问第三方系统，请遵守目标系统的服务条款。

---

## 🛠️ 快速上手

### 第一步：安装

> 如果你还没有安装 Node.js，请先参考 [Node.js 安装指南](https://nodejs.org/zh-cn/download/package-manager) 安装 Node 和 npm。

```bash
npm install -g webtape
```

### 第二步：注册 Native Messaging Host

```bash
webtape install
```

CLI 会按固定插件 ID `jcbbpjhckcknopggkbafcjnnhddjpfhm` 注册 Native Messaging Host，完成后插件就能在录制结束时自动将数据发送至本机 CLI。

### 第三步：录制并分析

在 WebTape 插件中完成录制，数据将自动保存到本地工作区，然后运行：

```bash
webtape analyze <session-name>
```

AI 将自动生成 `analysis_report.md` 业务文档及 `request.js` 可执行脚本。

---

## 📂 工作区结构

运行 `webtape install` 后，系统会在 `~/Desktop/WebTape`（可自定义）初始化工作区：

```
WebTape/
├── recordings/          # 所有录制会话
│   └── <session>/
│       ├── _context.md  # 由 CLI 生成的接口上下文文档（敏感头已脱敏）
│       ├── index.json
│       ├── requests/
│       └── responses/
└── AGENTS.md            # AI 分析规则，指导 Cursor/Claude 理解业务逻辑
```

---

## 🔒 隐私与数据安全

- 所有录制数据**仅存储于你的本机**，不上传至任何远程服务器。
- 生成的 `_context.md` 中，`Cookie` 头仅展示 cookie 名称列表（不含值），`Authorization`、`token` 等认证凭证头的值会被替换为 `[redacted]`。
- 完整的请求/响应原始数据保留在 `recordings/` 目录下，由你自行管理。

---

## 📋 CLI 命令参考

| 命令 | 选项 | 说明 |
|------|------|------|
| `install` | `--no-open` | 注册 Native Messaging Host；默认打开 Chrome Web Store 页 |
| `analyze` | `--backend` | 指定 AI 后端（`cursor` / `claude` / `none`） |
| `list` | — | 列出所有录制会话 |
| `config` | — | 交互式配置向导 |

---

## ⚠️ macOS 用户提示

生成的 `request.js` 脚本通过 `chrome-cookies-secure` 库读取本机 Chrome 的 Cookie，macOS 首次运行时会弹出安全提示，请输入**开机密码**并选择**「始终允许」**。

---

## 📄 开源协议

基于 **Apache License 2.0** 开源。

---

[返回 WebTape 主项目](https://github.com/FurtherBank/WebTape)
