# 🚀 WebTape Receiver：让网页自动化像录屏一样简单

**WebTape Receiver** 是 [WebTape](https://github.com/FurtherBank/WebTape) 生态中的核心动力引擎。  

它能将你在浏览器中的操作，瞬间转化为可直接运行且**不依赖网站 Open API 和浏览器手动操作**的自动化脚本。

不再需要抓包、不再需要分析复杂的 API 文档、不再需要手动处理 Cookie。你只需在浏览器里点一点，剩下的交给 WebTape。

---

## ✨ 核心价值：录制即自动化集成

通过 WebTape 插件录制你的业务操作，Receiver 会自动接收并保存所有网络请求。  

配合 AI 分析，它能直接理解你在网站上的操作，并将这些操作流程编写成**可以自动化运行的**`request.js`脚本，用于快速将网页操作以命令行、Agent 等形式自动化。

其中：
- 可自动复用你电脑 Chrome 浏览器的登录状态（Cookie），个人场景下运行无需额外网站登录过程。
- 对于上层业务流程，AI 会深度梳理接口间的调用链路，及其中输入和流转过程中的参数字段关系，帮你从繁琐的逆向工程和拼代码中解脱出来。

这使得你可以将生成的函数快速集成到自己的工具、爬虫或 Agent 中：  

让需要打开浏览器的操作可以**完全自动化**，  
让自动化 API 调用可以**不限于网站 Open API**，**只要日常浏览器使用能通的 API，自动化都可以通**

无论是获取私有接口数据，还是执行复杂的业务流程，都能像调用本地函数一样简单。

---

## 🛠️ 快速上手

### 第一步：安装
> 如果你还没有安装 Node.js，请先参考 [Node.js 安装指南](https://nodejs.org/zh-cn/download/package-manager) 安装 Node 和 npm。

只需一行命令，开启你的自动化之旅：

```bash
npm install -g webtape-receiver
```

### 第二步：启动服务
启动你的专属 Webhook 接收服务器：
```bash
webtape-receiver serve
```
*首次启动，将自动创建默认工作区在你的**桌面 `WebTape` 文件夹**下。*

### 第三步：配置插件
在 WebTape Chrome 插件中，将 Webhook 地址设置为：
`http://localhost:5643/webhook`

---

## WIP 视频演示

### 场景：从网页操作到自动化脚本生成

| 阶段 | 操作 | 核心产出 |
| :--- | :--- | :--- |
| **1. 接收** | 终端运行 `webtape-receiver serve`，插件端点击导出。 | 录制数据自动进入 `recordings/` 目录。 |
| **2. 分析** | 运行 `webtape-receiver analyze <session>`。 | AI 自动生成 `analysis_report.md` 业务文档。 |
| **3. 生成** | AI 根据 `AGENTS.md` 规则编写代码。 | 自动生成 `request.js`，包含封装好的业务函数。 |
| **4. 集成** | 在你的项目中 `import { xxx } from './request.js'`。 | **无需逆向工程**，直接实现网页功能自动化。 |

## 📂 你的自动化工作区 (Workspace)

当你运行 `serve` 命令时，系统会自动为你准备好一切：
- **recordings/**：安全存储你所有的录制会话。
- **AGENTS.md**：内置 AI 分析规则，确保你的 AI 助手（如 Cursor）能精准理解业务逻辑。
- **自动环境配置**：自动初始化 Node.js 环境并安装必要依赖，确保生成的脚本开箱即用。

---

## 💡 使用场景

- **数据采集**：无需研究复杂的反爬和登录校验，直接复用浏览器的登录态获取数据。
- **业务自动化**：将重复的网页操作转化为脚本，定时运行或集成到你的工作流中。
- **AI Agent 增强**：为你的 AI 助手提供直接操作真实业务接口的能力。

---

## ⚠️ 温馨提示 (macOS 用户)
生成的 request 代码最终基于`chrome-cookies-secure`库获取本机 Chrome 浏览器的 Cookie 信息，  
macOS 在第一次运行时会弹出安全提示。



- **操作**：请输入你的 **Mac 开机密码**。
- **建议**：请务必点击 **“始终允许” (Always Allow)**，以获得最流畅的自动化体验。

---

## 📄 开源协议
基于 **ISC** 协议开源。

---

**准备好释放网页自动化的潜力了吗？**  
[立即开始使用 WebTape](https://github.com/FurtherBank/WebTape)
