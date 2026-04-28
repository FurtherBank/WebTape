# Chrome Web Store 上线详尽流程报告

> **扩展名**：WebTape - Web Action Recorder  
> **扩展 ID**：`jcbbpjhckcknopggkbafcjnnhddjpfhm`（由 manifest 中的 `key` 固定）  
> **当前版本**：1.3.0  

---

## 一、前置准备

### 1.1 Google 开发者账号注册

1. 访问 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. 使用 Google 账号登录（推荐使用组织账号或专用发布账号，不要用个人日常账号）
3. **一次性注册费**：首次注册需支付 **$5 USD** 开发者注册费（通过信用卡支付）
4. 接受 Chrome Web Store 开发者协议

### 1.2 扩展资产准备清单

上线商店前需准备以下资产：

| 资产类型 | 规格要求 | 状态 |
|---------|---------|------|
| 扩展 ZIP 包 | 通过 `npm run build` 生成的 `webtape.zip` | ✅ 代码已修复，可直接构建 |
| 图标 128×128px | PNG，透明背景 | ✅ 已修复为正确尺寸 |
| 宣传截图 | **至少 1 张**，1280×800 或 640×400 PNG/JPEG | ⚠️ 需手动制作 |
| 小型宣传图（可选）| 440×280 PNG | ⚠️ 可选，建议制作 |
| 大型宣传图（可选）| 1400×560 PNG，用于商店首页展示 | ⚠️ 可选，建议制作 |
| 宣传视频（可选）| YouTube 视频链接 | ⚠️ 可选 |
| 商店详情描述（短）| 不超过 132 字符的英文简短描述 | ⚠️ 需手动填写 |
| 商店详情描述（长）| 最多 16000 字符，支持部分 HTML | ⚠️ 需手动填写 |
| 隐私政策 URL | 由于使用了 `nativeMessaging`、`debugger` 等敏感权限，**必填** | ⚠️ 需创建并托管隐私政策页面 |
| 主页 URL（可选） | 可填写 GitHub 仓库地址 | 可使用 `https://github.com/FurtherBank/WebTape` |

### 1.3 隐私政策要求（必须）

由于 WebTape 使用了以下敏感权限，**Chrome Web Store 强制要求提供隐私政策**：
- `debugger`（访问 CDP，可读取所有网络请求）
- `nativeMessaging`（与本机进程通信）
- `<all_urls>`（host permissions，可在所有网站运行）

隐私政策页面最低应包含：
- 扩展收集哪些数据（网络请求、用户操作）
- 数据如何使用（仅本地存储/分析，不上传至远程服务器）
- 数据保留策略
- 用户如何控制数据
- 联系方式

可以托管在 GitHub Pages 或任何公开可访问的 HTTPS 页面上。

---

## 二、构建发布包

### 2.1 本地构建

```bash
# 1. 安装根目录依赖（为 jszip 提供来源）
cd /path/to/WebTape
npm install

# 2. 安装 recorder 包依赖
cd packages/webtape-recorder
npm install

# 3. 构建 ZIP 包
npm run build

# 产物位于：packages/webtape-recorder/dist/webtape.zip
```

构建产物包含以下文件：
```
webtape.zip
├── manifest.json           (v1.3.0)
├── background.js           (Service Worker, CDP 嗅探)
├── content.js              (操作捕获)
├── rules.js                (采集规则)
├── popup.html              (弹窗 UI)
├── popup.js                (弹窗逻辑)
├── popup.css               (弹窗样式)
├── record-launcher.html    (外部链接启动页)
├── record-launcher.js      (外部链接启动逻辑)
├── lib/
│   └── jszip.min.js        (ZIP 打包库)
└── icons/
    ├── icon16.png          (16×16px)
    ├── icon32.png          (32×32px)
    ├── icon48.png          (48×48px)
    └── icon128.png         (128×128px)
```

### 2.2 通过 CI 构建（推荐发布流程）

```bash
# 打 Git 标签触发 CI 自动构建并创建 GitHub Release
git tag v1.3.0
git push origin v1.3.0
```

触发 `.github/workflows/release.yml`，自动：
1. 安装依赖
2. 构建 `webtape.zip`
3. 重命名为 `webtape-v1.3.0.zip`
4. 创建 GitHub Release 并上传 ZIP

---

## 三、Chrome Web Store 首次提交

### 3.1 创建新条目

1. 登录 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. 点击右上角 **「新建项目」** 按钮
3. 上传构建好的 `webtape.zip`（或 `webtape-v1.x.x.zip`）

> ⚠️ **重要**：第一次上传时，Chrome Web Store 会根据 manifest.json 中的 `key` 字段，将扩展固定到 ID `jcbbpjhckcknopggkbafcjnnhddjpfhm`。请确保上传的包中包含该 `key` 字段。

### 3.2 填写商店详情

**基本信息**
- **名称**：WebTape - Web Action Recorder（与 manifest.json 的 `name` 一致）
- **摘要（短描述）**：不超过 132 字符，例如：
  > Record web interactions and network requests, then export a structured ZIP for AI/LLM analysis.
- **详细描述**：参见 README.md 内容，翻译或改写为英文，包含主要功能、使用场景、配合 CLI 使用等

**分类**
- 建议选择：**Developer Tools**（开发者工具）

**语言**
- 主要语言：English

**网站**
- 主页 URL：`https://github.com/FurtherBank/WebTape`
- 支持 URL（Issue 页）：`https://github.com/FurtherBank/WebTape/issues`

### 3.3 上传视觉资产

- **截图**（必填至少 1 张）：1280×800 或 640×400，PNG 或 JPEG
  - 建议截图：Popup 界面展示、录制进行中状态、导出完成状态
- **图标**：128×128px PNG（manifest 中已正确配置，商店会从 ZIP 中提取）

### 3.4 隐私与权限说明

由于 manifest.json 中包含敏感权限，审核人员会要求解释其用途：

| 权限 | 必要性说明 |
|------|-----------|
| `debugger` | 使用 Chrome DevTools Protocol (CDP) 捕获网络请求（XHR/Fetch/WebSocket/SSE），是核心录制功能的基础 |
| `nativeMessaging` | 将录制数据发送至本地安装的 WebTape CLI 进行 AI 分析 |
| `<all_urls>` (host_permissions) | Content Script 需要在任意网页上捕获用户操作事件 |
| `tabs` | 获取当前活动标签页信息以启动录制 |
| `activeTab` | 允许访问用户当前激活的标签页 |
| `scripting` | 向网页注入 content script |
| `storage` | 存储扩展配置项 |

**隐私政策 URL**：必须填写，否则无法提交（含 `debugger`、`nativeMessaging` 等高风险权限的扩展必须有隐私政策）

### 3.5 提交审核

填写完所有必填项后，点击 **「提交以供审核」**。

**首次审核时间预期**：通常 **1-3 个工作日**，有时会因权限敏感（使用了 `debugger`、`nativeMessaging`）而需要更长时间（最长 2 周）。

---

## 四、权限审核风险评估

WebTape 使用了 Chrome Web Store 视为高风险的权限，审核可能会要求提供额外说明或演示视频。

### 高风险权限说明

**1. `debugger` 权限**
- Chrome Web Store 对此权限审核极为严格
- 需在开发者详情中详细说明**为何需要此权限**
- 必须附上演示截图/视频展示功能
- 典型被拒理由：权限使用超出声明范围、仿冒调试工具等

**2. `nativeMessaging` 权限**
- 需要解释与哪个本地应用通信（`com.webtape.receiver`）
- 需要解释通信内容和目的

**3. `<all_urls>` host permissions**
- 需要合理说明为何需要访问所有网站

### 如果审核被拒

1. 查看拒绝邮件中的具体原因
2. 修改扩展或补充说明后，在 Dashboard 点击 **「重新提交」**
3. 可以通过 [Chrome Web Store 开发者支持](https://support.google.com/chrome_webstore/contact/developer) 申诉

---

## 五、更新发布流程

### 5.1 版本号规范

- 遵循 `major.minor.patch` 语义化版本
- 更新时修改 `packages/webtape-recorder/manifest.json` 中的 `version` 字段
- **每次发布必须递增版本号**（Chrome Web Store 不接受相同版本号的更新）

### 5.2 更新上传步骤

1. 修改 `manifest.json` 中的 `version` 字段（例如 `1.3.0` → `1.4.0`）
2. 打 Git 标签触发 CI 构建：
   ```bash
   git tag v1.4.0
   git push origin v1.4.0
   ```
3. 从 GitHub Release 下载 `webtape-v1.4.0.zip`
4. 登录 Chrome Web Store Developer Dashboard
5. 点击扩展条目 → 「包」→ 「上传新程序包」
6. 上传新 ZIP 文件
7. 根据变更更新商店详情（可选）
8. 点击「提交以供审核」

### 5.3 更新审核时间

版本更新通常比首次发布审核更快（**数小时至 1 个工作日**），除非修改了权限或功能。

---

## 六、发布后的维护

- 监控 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) 中的用户评分和评论
- 关注 GitHub Issues 中的 Bug 报告
- 保持扩展与最新 Chrome API 的兼容性
- 定期更新隐私政策（如功能有变动）
- 当 Chrome 发布不兼容变更时，及时更新扩展

---

## 七、扩展 ID 固定说明

WebTape 通过 `manifest.json` 中的 `key` 字段固定了扩展 ID：
```
jcbbpjhckcknopggkbafcjnnhddjpfhm
```

这与 CLI 工具 `webtape install` 注册 Native Messaging Host 时使用的扩展 ID 完全一致。**商店版本和开发者模式加载版本使用相同的 ID**，用户无需更换链接模板或重新配置 CLI。

**注意**：`key` 字段仅在开发者加载时使用，正式商店版本由 Google 根据 Chrome Web Store 账号颁发的密钥决定扩展 ID。首次上传时，如果商店分配的 ID 与 `key` 推导的 ID 不同，需要更新 CLI 中的 `WEBTAPE_EXTENSION_ID` 常量。
