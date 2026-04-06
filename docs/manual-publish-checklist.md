# Chrome Web Store 上线手动操作清单

> **适用版本**：WebTape v1.3.0  
> **代码状态**：已完成所有代码修复，可直接构建上线  

---

## 第一步：准备 Google 开发者账号（一次性）

- [ ] 访问 https://chrome.google.com/webstore/devconsole 并登录 Google 账号
- [ ] 支付 $5 USD 开发者注册费（信用卡）
- [ ] 阅读并同意 Chrome Web Store 开发者协议

---

## 第二步：构建扩展 ZIP 包

在项目根目录执行（或直接使用 CI 打标签后从 GitHub Release 下载）：

```bash
# 本地构建方式
npm install
cd packages/webtape-recorder
npm install
npm run build
# 产物：packages/webtape-recorder/dist/webtape.zip
```

或者通过打标签让 CI 自动构建：
```bash
git tag v1.3.0
git push origin v1.3.0
# 然后从 GitHub Releases 页面下载 webtape-v1.3.0.zip
```

- [ ] 确认 ZIP 包已成功生成
- [ ] 验证 ZIP 包包含：manifest.json、background.js、content.js、rules.js、popup.html、popup.js、popup.css、record-launcher.html、record-launcher.js、lib/jszip.min.js、icons/（16/32/48/128px）

---

## 第三步：准备商店视觉资产（必填）

- [ ] **宣传截图至少 1 张**（1280×800 或 640×400，PNG/JPEG）
  - 建议截：扩展 Popup 界面（录制前、录制中两张状态）
  - 工具推荐：直接在 Chrome 中加载扩展后截图
- [ ] （可选）制作小型宣传图 440×280 PNG
- [ ] （可选）制作大型横幅 1400×560 PNG（商店首页展示用）
- [ ] （可选）录制 YouTube 宣传视频并获取链接

---

## 第四步：创建隐私政策页面（必须）

> WebTape 使用了 `debugger`、`nativeMessaging`、`<all_urls>` 等高风险权限，Chrome Web Store **强制要求**提供隐私政策。

- [ ] 起草隐私政策文档，须包含：
  - 收集的数据类型（网络请求内容、用户操作记录）
  - 数据用途（仅本地 AI 分析，不上传至远程服务器）
  - 数据存储方式和保留时长
  - 用户数据控制权（如何删除）
  - 联系邮箱
- [ ] 将隐私政策发布到公开可访问的 HTTPS 地址
  - 推荐方式：在 GitHub 仓库创建 `privacy-policy.md`，通过 GitHub Pages 发布
  - 或：直接在 GitHub 仓库 README 中添加隐私政策章节，使用 Raw URL
- [ ] 记录隐私政策的完整 URL（填写商店时需要）

---

## 第五步：首次提交至 Chrome Web Store

- [ ] 登录 https://chrome.google.com/webstore/devconsole
- [ ] 点击 **「新建项目」**
- [ ] 上传 `webtape.zip`（或 `webtape-v1.3.0.zip`）
- [ ] 等待上传解析完成，确认无报错

### 填写商店详情

- [ ] **简短描述**（≤132 字符，英文）：
  ```
  Record web interactions and network requests, then export a structured ZIP for AI/LLM analysis.
  ```
- [ ] **详细描述**（英文，可参考 README.md）：
  - 介绍核心功能：Direct Record / Refresh & Record / Stop & Analyze
  - 介绍 ZIP 输出格式（index.json + requests/ + responses/）
  - 介绍配合 WebTape CLI 使用的场景
  - 说明 AI 分析功能

- [ ] **分类**：Developer Tools（开发者工具）
- [ ] **语言**：English
- [ ] **主页 URL**：`https://github.com/FurtherBank/WebTape`
- [ ] **支持 URL**：`https://github.com/FurtherBank/WebTape/issues`
- [ ] **隐私政策 URL**：（填写第四步中创建的 URL）

### 上传视觉资产

- [ ] 上传至少 1 张宣传截图
- [ ] （可选）上传小型/大型宣传图
- [ ] （可选）填写 YouTube 视频链接

### 权限说明（审核员会查看）

在「详细描述」或「开发者说明」中加入以下权限说明（如 Dashboard 有单独填写权限说明的字段则填写那里）：

- [ ] 填写权限说明，内容参考：
  ```
  - debugger: Required to capture network requests (XHR/Fetch/WebSocket/SSE) via Chrome DevTools Protocol (CDP). This is the core mechanism for recording API calls.
  - nativeMessaging: Used to send recorded data to the locally-installed WebTape CLI (com.webtape.receiver) for AI analysis. No data is sent to remote servers.
  - <all_urls>: Content scripts need to run on any page to capture user interaction events (clicks, form changes, keyboard shortcuts).
  - tabs/activeTab: To identify the current tab being recorded.
  - scripting: To inject content scripts into web pages.
  - storage: To persist extension settings.
  ```

### 提交

- [ ] 检查所有必填项已填写
- [ ] 点击 **「提交以供审核」**
- [ ] 记录提交时间（预计 1-3 个工作日审核完成，高风险权限可能需要 2 周）

---

## 第六步：等待审核并处理反馈

- [ ] 关注注册邮箱的审核通知邮件
- [ ] 如果审核通过：扩展将自动发布至 Chrome Web Store，可在以下地址查看：
  `https://chrome.google.com/webstore/detail/jcbbpjhckcknopggkbafcjnnhddjpfhm`
- [ ] 如果审核被拒：
  - 仔细阅读拒绝原因
  - 根据要求修改代码或补充说明
  - 在 Dashboard 点击「重新提交」

---

## 第七步：验证上线后的功能（上线后）

- [ ] 从 Chrome Web Store 安装扩展（非开发者模式）
- [ ] 验证扩展 ID 是否为 `jcbbpjhckcknopggkbafcjnnhddjpfhm`
  （在 `chrome://extensions` 页面查看）
- [ ] 运行 `webtape install` 确保 Native Messaging Host 注册正常
- [ ] 测试录制功能：打开任意网页 → Direct Record → 操作几步 → Stop & Analyze
- [ ] 验证 Native Host 连接：点击扩展 Settings → 检测 Native Host 连接

---

## 关键信息汇总

| 项目 | 值 |
|-----|-----|
| 扩展 ID | `jcbbpjhckcknopggkbafcjnnhddjpfhm` |
| Native Host 名 | `com.webtape.receiver` |
| 当前版本 | 1.3.0 |
| 构建命令 | `cd packages/webtape-recorder && npm run build` |
| 开发者 Dashboard | https://chrome.google.com/webstore/devconsole |
| GitHub 仓库 | https://github.com/FurtherBank/WebTape |

---

## 注意事项

1. **扩展 ID 固定**：manifest.json 中的 `key` 字段确保商店版本和开发者版本使用相同 ID，无需担心 ID 变更。

2. **`debugger` 权限审核**：这是 Chrome Web Store 审核最严格的权限之一，务必在描述中清晰说明用途，并提供截图/视频佐证。

3. **每次版本更新**：必须递增 `manifest.json` 中的 `version`，然后重新打包上传，不能用相同版本号覆盖。

4. **不要删除 manifest.json 中的 `key` 字段**：这个字段固定了扩展 ID，删除后开发者模式加载的扩展 ID 会变化，导致 CLI 无法正常通信。
