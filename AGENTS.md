# WebTape 项目说明

## 项目结构

- **根目录** — Monorepo 协调层（工作区根，不直接包含业务代码）
- **`packages/webtape-cli/`** — Node.js CLI 工具（npm 包名 `webtape`），通过 Native Messaging 被插件调起，保存录制数据并通过 AI 分析
- **`packages/webtape-recorder/`** — Chrome 扩展插件（`background.js`、`content.js`、`popup.js` 等），负责录制网页操作和网络请求

## 架构说明

插件与 CLI 通过 **Chrome Native Messaging** 通信，无需用户手动启动服务。官方发行与源码解压加载使用同一扩展 ID：`jcbbpjhckcknopggkbafcjnnhddjpfhm`（由 `packages/webtape-recorder/manifest.json` 的 `key` 决定）。

1. 用户运行 `npm install -g webtape` + `webtape install` 完成一次性初始化
2. `webtape install` 向系统注册 Native Messaging host manifest
3. 之后插件停止录制时，Chrome 自动按需 spawn `webtape` 进程处理数据
4. AI 分析作为 detached 子进程独立运行，不阻塞插件

## 开发测试

### webtape CLI

编辑完代码后：
```bash
cd packages/webtape-cli
npm start   # 编译 + npm link 全局
```

测试 Native Messaging 协议（模拟 Chrome 发送 ping）：
```bash
# 参见 src/native-host.ts 中的协议说明
webtape install --no-open   # 注册 host manifest
```

### webtape-recorder 扩展

构建扩展 ZIP 包：
```bash
cd packages/webtape-recorder
npm run build   # 输出 dist/webtape.zip
```

## 发布流程

### 插件发布（Chrome Extension）

推送一个以 `v` 开头的 Git 标签，CI 自动构建并创建 GitHub Release：

```bash
git tag v1.x.x
git push origin v1.x.x
```

触发 `.github/workflows/release.yml`，在 `packages/webtape-recorder/` 目录下构建 `dist/webtape-v1.x.x.zip` 并附到 Release。

### CLI 发布（webtape npm 包）

修改 `packages/webtape-cli/package.json` 中的 `version` 字段后直接推送到 `main`，CI 检测到版本变更后自动发布到 npm：

```bash
# 1. 修改 packages/webtape-cli/package.json 中的 version
# 2. 提交并推送
git add packages/webtape-cli/package.json
git commit -m "chore: bump webtape version to x.x.x"
git push
```

触发 `.github/workflows/publish-receiver.yml`，检测 `package.json` 版本变化后执行 `npm publish`。
