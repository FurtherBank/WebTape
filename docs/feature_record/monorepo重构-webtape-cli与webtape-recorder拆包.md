# monorepo 重构：webtape-cli 与 webtape-recorder 拆包

## 用户需求

重构 webtape 的产品构成形态：
1. 原 receiver 改为 webtape 官方命令行工具（`packages/webtape-cli/`）
2. 原 webtape 插件改为 webtape-recorder 插件，变为一个独立子包（`packages/webtape-recorder/`）

修改时间：2026-04-04 00:00:00

## 阶段一：完成标准

### 理解用户意图

- 项目从「单 packages 目录 + 根目录放扩展文件」形态，演进为标准 monorepo 形态
- CLI 工具包从 `packages/webtape-receiver/` 重命名为 `packages/webtape-cli/`，对外命令统一使用 `webtape`
- Chrome 扩展文件从根目录整体提取，形成独立子包 `packages/webtape-recorder/`，承接原根目录的依赖和构建脚本
- 根目录降级为 monorepo 协调层，不再承担实际业务代码
- 所有 CI/CD 工作流路径随之更新

### 关键实现点

- `packages/webtape-cli/` 存在（原 `packages/webtape-receiver/` 重命名），`package.json` 中 `bin` 只保留 `webtape`，移除 `webtape-receiver` alias
- `packages/webtape-recorder/` 存在，包含 `manifest.json`、`background.js`、`content.js`、`popup.*`、`icons/`、`lib/` 等所有扩展文件及新建的 `package.json`
- 根目录下不再存在扩展文件（`manifest.json`、`background.js`、`icons/` 等）
- 根目录 `package.json` 移除 `jszip` 依赖、`postinstall`/`build` 脚本，`start`/`dev` 指向 `packages/webtape-cli`
- `packages/webtape-cli/src/index.ts` 中面向用户的命令提示不再出现 `webtape-receiver`
- `.github/workflows/publish-receiver.yml` 所有路径引用指向 `packages/webtape-cli`
- `.github/workflows/release.yml` 构建步骤工作目录为 `packages/webtape-recorder/`

### 自测用例

- ⭐ `packages/webtape-cli/` 目录存在，包含完整 `src/`、`workspace/`、`scripts/` 等内容
- ⭐ `packages/webtape-recorder/` 目录存在，包含 `manifest.json`、`background.js`、`content.js`、`popup.*`、`icons/`、`lib/` 等所有扩展文件
- 根目录下不再存在 `manifest.json`、`background.js`、`icons/` 等扩展文件
- ⭐ `packages/webtape-cli/package.json` 中 `bin` 字段只有 `webtape`，不含 `webtape-receiver`
- `packages/webtape-cli/src/index.ts` 中面向用户的命令提示中不再出现 `webtape-receiver` 字样
- `packages/webtape-recorder/package.json` 存在，包含 `jszip` 依赖和 `build` 脚本
- `packages/webtape-recorder/lib/` 目录存在（从根目录迁移过来）
- `publish-receiver.yml` 所有路径引用均指向 `packages/webtape-cli`
- `release.yml` 构建步骤工作目录为 `packages/webtape-recorder/`

## 代码修改路径

1. **Shell：重命名 CLI 包目录** — `packages/webtape-receiver/` → `packages/webtape-cli/`（`mv` 整个目录）
2. **Shell：新建 `packages/webtape-recorder/` 并迁移扩展文件** — 从根目录移动 `manifest.json`、`background.js`、`content.js`、`popup.*`、`rules.js`、`record-launcher.*`、`icons/`、`lib/`
3. **新建 `packages/webtape-recorder/package.json`** — `name: webtape-recorder`，`private: true`，承接 `jszip` 依赖和 `build`/`postinstall` 脚本
4. **修改 `packages/webtape-cli/package.json`** — 移除 `webtape-receiver` bin alias，更新 `repository.directory` 和 `homepage`
5. **修改根目录 `package.json`** — 移除 `jszip` 依赖和 `postinstall`/`build` 脚本，路径从 `webtape-receiver` → `webtape-cli`
6. **修改 `packages/webtape-cli/src/index.ts`** — 4 处用户提示命令引用从 `webtape-receiver` → `webtape`
7. **修改 `packages/webtape-cli/src/server.ts`** — `service: 'webtape-receiver'` → `service: 'webtape'`
8. **修改 `packages/webtape-cli/src/rules.ts`** — 文件头注释更新
9. **修改 `packages/webtape-cli/src/templates/context.md.ejs`** — 自动生成署名更新
10. **修改 `packages/webtape-cli/workspace/package.json`** — description 更新
11. **修改 `packages/webtape-cli/workspace/AGENTS.md`** — 自动生成声明更新
12. **修改 `packages/webtape-recorder/rules.js`** — 注释中路径引用更新
13. **修改根目录 `AGENTS.md`** — 反映新项目结构和两个子包职责
14. **修改 `.github/workflows/publish-receiver.yml`** — 全量替换 `webtape-receiver` → `webtape-cli`
15. **修改 `.github/workflows/release.yml`** — 安装/构建步骤加 `working-directory: packages/webtape-recorder`，产物路径更新
16. **修改根目录 `README.md`** — 命令演示、包路径描述更新
17. **修改 `packages/webtape-cli/README.md`** — 命令演示更新

## 测试执行情况

### 目录结构检查

- ✅ `packages/webtape-cli/` 目录存在，包含 `src/`、`workspace/`、`scripts/`、`bin/`、`dist/` 等完整内容
- ✅ `packages/webtape-recorder/` 目录存在，包含 `manifest.json`、`background.js`、`content.js`、`popup.html/js/css`、`record-launcher.html/js`、`rules.js`、`icons/`、`lib/` 所有扩展文件
- ✅ 根目录已清洁，无残留扩展文件

### CLI 包检查

- ✅ `packages/webtape-cli/package.json` 中 `bin` 字段：`{"webtape":"./dist/index.js"}`，无 `webtape-receiver`
- ✅ `packages/webtape-cli/src/index.ts` 中用户提示命令已全部改为 `webtape`（全局搜索无 `webtape-receiver` 字样）

### 扩展包检查

- ✅ `packages/webtape-recorder/package.json` 存在，`name: webtape-recorder`，`private: true`，含 `jszip` 依赖和 `build`/`postinstall` 脚本
- ✅ `packages/webtape-recorder/lib/jszip.min.js` 存在

### CI/CD 检查

- ✅ `publish-receiver.yml` 中所有 `paths`、`working-directory`、`require()` 路径均指向 `packages/webtape-cli`，无残留 `webtape-receiver`
- ✅ `release.yml` 中安装依赖和构建步骤均有 `working-directory: packages/webtape-recorder`，产物路径正确

### 合理保留的 `webtape-receiver` 引用

- `packages/webtape-cli/src/config.ts`：`CONFIG_DIR = ~/.webtape-receiver`（需求明确要求向后兼容，刻意保留）
- `packages/webtape-cli/package-lock.json`：旧 bin 记录（下次 `npm install` 自动更新）
- `packages/webtape-cli/docs/feature_record/*.md`：历史功能记录文档（不修改历史记录是规范）

## 代码风险信号

### 识别到的风险信号

#### 1. 修改扩散效应 - `rules.js` 与 `src/rules.ts` 双副本机制

- **问题描述**：`packages/webtape-recorder/rules.js`（插件侧）和 `packages/webtape-cli/src/rules.ts`（CLI 侧）维护了两份"采集/呈现"规则。`rules.js` 注释中声明了它应该与 `src/rules.ts` 保持同步，但没有任何机制强制保证两者一致性。
- **代码位置**：`packages/webtape-recorder/rules.js` 第 1-20 行注释；`packages/webtape-cli/src/rules.ts` 整体
- **影响评估**：规则变更时，开发者需要手动同步两处改动。如果只改一处，插件侧和 CLI 侧的过滤/格式化行为将出现静默偏差，导致数据出入难以排查。
- **优先级**：中

#### 2. 隐性认知过多 - `postinstall` 路径假设

- **问题描述**：`packages/webtape-recorder/package.json` 中 `postinstall` 脚本使用了相对路径 `../../node_modules/jszip/dist/jszip.min.js`，隐性依赖于该包**必须在根目录安装**（即根目录 monorepo 用 `npm install` 且 hoisting jszip 到根 node_modules）。若未来改用 pnpm workspace 或在子包独立安装，此脚本将静默失败。
- **代码位置**：`packages/webtape-recorder/package.json` scripts.postinstall
- **影响评估**：`lib/jszip.min.js` 文件无法复制，插件构建产物会包含过时版本（已有 lib/ 中的文件）或完全缺失，导致扩展运行时报错。
- **优先级**：低（当前使用 npm workspaces，根 node_modules hoisting 正常，近期不受影响）

#### 3. 防御性缺失 - `release.yml` 中 `files` glob 依赖单一产物路径

- **问题描述**：`release.yml` 的 `Create GitHub Release` 步骤使用 `files: packages/webtape-recorder/dist/webtape-*.zip`，但前一步 `Rename package with version` 在 `mv` 失败时不会使 CI 中断（依赖 shell 默认 `-e` 设置）。如果 `build` 步骤未生成 `dist/webtape.zip`，`mv` 会静默失败，`files` glob 匹配不到文件，Release 会被创建但没有附件，用户无感知。
- **代码位置**：`.github/workflows/release.yml` 第 25-38 行
- **影响评估**：可能产生没有资产附件的"空 Release"，用户无法下载扩展包。
- **优先级**：低（构建脚本本身出错会让 CI 退出，仅在极端情况下触发）
