# 产品形态重构：receiver 改 CLI 子包，插件迁移为 webtape-recorder 子包

## 用户需求

重构 webtape 的产品构成形态：
1. 原 receiver 改为 webtape 官方命令行工具
2. 原 webtape 插件改为 webtape-recorder 插件，变为一个 package 子包

修改时间：2026-04-04 00:00:00

## 阶段一：完成标准

### 理解用户意图

- 现在根目录承载 Chrome 扩展，`packages/webtape-receiver` 承载 CLI 工具，名字取自实现细节 "Native Messaging receiver"，对外不直观
- 用户希望将这两个产品角色都以干净的 `packages/` 子包形式组织，并用语义化的名字命名：CLI 工具保留 `webtape` 包名但目录改为 `webtape-cli`，Chrome 扩展迁移到 `packages/webtape-recorder/`
- 根目录将转变为纯 monorepo 协调层

### 关键实现点

- `packages/webtape-receiver/` → 重命名为 `packages/webtape-cli/`
  - `package.json` 中 `bin` 字段移除 `webtape-receiver` alias（只保留 `"webtape": "./dist/index.js"`）
  - `package.json` 中 `repository.directory` / `homepage` 更新路径
  - `src/index.ts` 中所有面向用户的提示文字若含 `webtape-receiver config` 等命令引用改为 `webtape config` / `webtape`
- Chrome 扩展文件（`manifest.json`、`background.js`、`content.js`、`popup.*`、`rules.js`、`record-launcher.*`、`icons/`、`lib/`）整体迁移至新建的 `packages/webtape-recorder/`
  - 新建 `packages/webtape-recorder/package.json`（`name: "webtape-recorder"`, `private: true`），承接根目录原有的 `jszip` 依赖和 `postinstall` / `build` 脚本
- 根目录 `package.json` 转型为 monorepo 协调层：移除扩展相关的 `jszip` 依赖和 `postinstall`/`build` 脚本；`scripts.start` / `scripts.dev` 路径更新
- CI/CD 工作流路径全量更新
- 根目录 `AGENTS.md` 更新，反映新的项目结构

### 自测用例

#### 目录结构正确性
- ⭐ `packages/webtape-cli/` 目录存在，内容完整，`package.json` 中 `bin` 仅保留 `webtape`
- ⭐ `packages/webtape-recorder/` 目录存在，包含全部扩展文件
- 根目录下不再存在 `manifest.json`、`background.js`、`icons/` 等扩展文件

#### CLI 包
- ⭐ `packages/webtape-cli/package.json` 中 `bin` 字段只有 `webtape`，不含 `webtape-receiver`
- `src/index.ts` 中面向用户的命令提示中不再出现 `webtape-receiver` 字样

#### 扩展包
- `packages/webtape-recorder/package.json` 存在，包含 `jszip` 依赖和 `build` 脚本

#### CI/CD 配置
- ⭐ `publish-receiver.yml` 所有路径引用均指向 `packages/webtape-cli`
- `release.yml` 构建步骤工作目录为 `packages/webtape-recorder/`

## 代码修改路径

**1. Shell：重命名 CLI 包目录**
- `packages/webtape-receiver/` → `packages/webtape-cli/`（整个目录 mv）

**2. Shell：新建 `packages/webtape-recorder/` 并迁移扩展文件**
- 从根目录移动 `manifest.json`、`background.js`、`content.js`、`popup.*`、`rules.js`、`record-launcher.*`、`icons/`、`lib/` 至 `packages/webtape-recorder/`

**3. 新建 `packages/webtape-recorder/package.json`**
- `name: "webtape-recorder"`，`private: true`，承接 `jszip` 依赖和 `postinstall`/`build` 脚本

**4. 修改 `packages/webtape-cli/package.json`**
- `bin` 字段移除 `webtape-receiver` alias，更新 `repository.directory` / `homepage`

**5. 修改根目录 `package.json`**
- 移除 `jszip` 依赖、`postinstall`、`build` 脚本；更新 `start`/`dev` 路径

**6. 修改 `packages/webtape-cli/src/index.ts`**
- 第 54、216、270、324 行 `webtape-receiver` 命令引用 → `webtape`

**7. 修改 `packages/webtape-cli/src/server.ts`**
- `service: 'webtape-receiver'` → `service: 'webtape'`

**8. 修改 `packages/webtape-cli/src/rules.ts`、`src/templates/context.md.ejs`、`workspace/package.json`、`workspace/AGENTS.md`**
- 各处 `webtape-receiver` 署名/注释 → `webtape`

**9. 修改 `packages/webtape-recorder/rules.js`**
- 顶部注释路径引用 `packages/webtape-receiver/src/rules.ts` → `packages/webtape-cli/src/rules.ts`

**10. 修改根目录 `AGENTS.md`**
- 更新结构描述、路径引用

**11. 修改 `.github/workflows/publish-receiver.yml`**
- 全量 `webtape-receiver` → `webtape-cli`

**12. 修改 `.github/workflows/release.yml`**
- `Install dependencies` / `Build extension package` 步骤加 `working-directory: packages/webtape-recorder`；产物路径更新

**13. 修改根目录 `README.md` 和 `packages/webtape-cli/README.md`**
- 命令演示、路径描述更新

## 测试执行情况

- **交付自测**：通过文件存在性检查和内容验证执行了所有自测用例，全部通过。
  - `packages/webtape-cli/` 和 `packages/webtape-recorder/` 均正确存在
  - 根目录无扩展文件残留
  - CLI bin 字段仅保留 `webtape`
  - `src/index.ts` 无旧命令名引用
  - `publish-receiver.yml` 路径全量更新为 `webtape-cli`
  - `release.yml` 构建步骤工作目录正确

## 代码风险信号

### 识别到的风险信号

#### 1. 修改扩散效应 - `rules.js` 与 `src/rules.ts` 双副本机制
- **问题描述**：`packages/webtape-recorder/rules.js`（插件侧）和 `packages/webtape-cli/src/rules.ts`（CLI 侧）维护了两份功能相近的「采集/呈现」规则，注释中声明应同步，但无自动化机制强制保证一致性。
- **代码位置**：`packages/webtape-recorder/rules.js` 第 1-20 行；`packages/webtape-cli/src/rules.ts` 整体
- **影响评估**：规则变更时若只改一处，插件侧和 CLI 侧行为出现静默偏差，导致录制数据与呈现结果难以对齐排查。
- **优先级**：中

#### 2. 隐性认知过多 - `postinstall` 相对路径假设
- **问题描述**：`packages/webtape-recorder/package.json` 的 `postinstall` 脚本使用 `../../node_modules/jszip/...`，隐性依赖根目录 monorepo 的 hoisting。改用 pnpm workspace 或子包独立安装时此脚本会静默失败。
- **代码位置**：`packages/webtape-recorder/package.json` → `scripts.postinstall`
- **影响评估**：`lib/jszip.min.js` 无法复制，扩展构建产物缺失依赖，运行时报错。
- **优先级**：低（当前 npm workspaces hoisting 正常，近期不受影响）

#### 3. 防御性缺失 - `release.yml` 产物路径无验证
- **问题描述**：`release.yml` 中 `Rename package with version` 步骤未对 `build` 产物存在性做前置检查，若构建产物缺失，`mv` 静默失败，会创建无附件的空 Release。
- **代码位置**：`.github/workflows/release.yml` `Rename package with version` 步骤
- **影响评估**：可能产生无资产附件的空 Release，用户无法下载扩展包，且无告警。
- **优先级**：低
