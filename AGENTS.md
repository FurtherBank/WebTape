# WebTape 项目说明

## 项目结构

- **根目录** — Chrome 扩展插件（`background.js`、`content.js`、`popup.js` 等）
- **`packages/webtape-receiver/`** — Node.js CLI 工具，接收 webhook 数据并分析录制结果

## 发布流程

### 插件发布（Chrome Extension）

推送一个以 `v` 开头的 Git 标签，CI 自动构建并创建 GitHub Release：

```bash
git tag v1.x.x
git push origin v1.x.x
```

触发 `.github/workflows/release.yml`，构建 `dist/webtape-v1.x.x.zip` 并附到 Release。

### receiver 发布（webtape-receiver npm 包）

修改 `packages/webtape-receiver/package.json` 中的 `version` 字段后直接推送到 `main`，CI 检测到版本变更后自动发布到 npm：

```bash
# 1. 修改 packages/webtape-receiver/package.json 中的 version
# 2. 提交并推送
git add packages/webtape-receiver/package.json
git commit -m "chore(receiver): bump version to x.x.x"
git push
```

触发 `.github/workflows/publish-receiver.yml`，检测 `package.json` 版本变化后执行 `npm publish`。
