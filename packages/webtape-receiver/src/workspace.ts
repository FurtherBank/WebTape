import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

export interface WorkspacePaths {
  root: string;
  recordings: string;
}

/**
 * Resolve the WebTape workspace root. Priority:
 * 1. Explicit --workspace CLI flag
 * 2. ~/Desktop/WebTape (works on macOS and Windows)
 */
export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit) return explicit;
  return join(homedir(), 'Desktop', 'WebTape');
}

/**
 * Content for workspace AGENTS.md — the analysis prompt template.
 */
export const AGENTS_MD_CONTENT = `<!-- ⚠️ 此文件由 webtape-receiver 工具自动生成和维护，请勿手动修改 -->

# WebTape 录制分析 Agent

你是一个专业的 Web 前端业务分析专家。请根据指定的 WebTape 录制数据目录，分析该网页的业务逻辑和完整接口链路。

## 任务

1. **梳理用户操作流程**：
   - **网站概况分析**：首先梳理录制记录所在网站的基本情况。例如：这是 B 站某个用户的个人主页，页面中展示了投稿视频列表、收藏夹、粉丝数等信息，可以进行点赞、投币、收藏视频等操作。
   - **还原操作路径**：根据 \`index.json\` 中的 \`action\` 序列，结合网站概况，还原用户的完整操作路径。这些内容将作为后续接口与页面业务逻辑关系梳理的参照。
2. **分析接口调用链路**：
   - 列出每个用户操作触发的所有 API 请求
   - 标注请求方法、URL、状态码
   - 分析请求之间的依赖关系（例如：登录后拿到 token，后续请求携带 token）
3. **识别业务模块**：根据 URL 模式和请求内容，划分业务模块（如：用户认证、数据查询、表单提交等）
4. **生成接口文档概要**：对每个接口给出简要说明，包括用途、请求参数、响应结构
5. **绘制链路图**：用 Mermaid 序列图描述核心业务流程的接口调用时序
6. **生成业务逻辑代码 (request.js)**：
   - 使用 ES Module 格式编写。
   - 导出若干业务逻辑流程的 JS 函数实现。
   - 每个导出的函数都必须对应在这个页面中，用户视角的一个完整业务过程。
   - **代码规范参考**：
     \`\`\`javascript
     // 引入 chromeFetch，其与原生 fetch 无异，但是会自动使用电脑本地 chrome 的 cookie。
     import { chromeFetch } from '@cpu-utils/headless'

     /**
      * 获取知乎收藏夹内容 (示例)
      * @param {Object} params - 业务参数
      * @param {string} params.userId - 用户 ID
      */
     export async function getZhiHuCollection(params) {
       // 1. 提取业务逻辑对用户使用角度所需的接口入参
       const { userId } = params
       
       // 2. 如果获取最终响应的接口需要前置接口返回作为入参，请在此处体现该过程
       
       // 3. 调用接口并返回结果
       const url = 'https://www.zhihu.com/api/v4/members/' + userId + '/collections'
       const res = await chromeFetch(url, {
         method: 'GET',
         // ... 其它原生 fetch 参数
       })
       return res
     }
     \`\`\`

## 非业务接口处理

对于以下类型的非页面核心业务逻辑接口，**不要展开详细分析**，仅在报告中简要归类提及即可：
- 埋点上报（tracking / analytics）
- 性能监控（performance monitoring）
- 错误日志上报（error reporting）
- 广告请求（ad requests）
- 第三方统计 SDK 请求（如 Google Analytics、百度统计等）

这些接口在分析报告中统一归入"非业务辅助接口"章节，列出接口 URL 模式即可，无需分析请求参数和响应结构。

## 数据结构

录制数据位于 \`recordings/<记录名>/\` 目录下，包含：
- \`index.json\` — 用户操作与网络请求时间线
- \`meta.json\` — 录制元数据
- \`requests/\` — 各请求的详细数据（请求头、请求体等）
- \`responses/\` — 各响应的详细数据（状态码、响应头、响应体等）

## 输出要求

1. **分析报告**：Markdown 格式，保存到 \`recordings/<记录名>/analysis_report.md\`。
2. **业务逻辑代码**：JavaScript 格式，保存到 \`recordings/<记录名>/request.js\`。
`;

/**
 * Ensure workspace template files (package.json, AGENTS.md) are up-to-date.
 * Re-writes them whenever the CLI version changes.
 * Returns whether the templates were written.
 */
function ensureWorkspaceTemplates(root: string, version: string): boolean {
  const pkgPath = join(root, 'package.json');
  const agentsPath = join(root, 'AGENTS.md');

  let needsUpdate = false;

  if (!existsSync(pkgPath)) {
    needsUpdate = true;
  } else {
    try {
      const existing = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (existing.version !== version) {
        needsUpdate = true;
      }
    } catch {
      needsUpdate = true;
    }
  }

  if (needsUpdate || !existsSync(agentsPath)) {
    const pkg = {
      name: 'webtape-workspace',
      version,
      private: true,
      description: 'WebTape 录制工作区，由 webtape-receiver CLI 维护',
    };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    writeFileSync(agentsPath, AGENTS_MD_CONTENT, 'utf-8');
    return true;
  }
  return false;
}

/**
 * Ensure the workspace directory tree exists and return the resolved paths.
 */
export function ensureWorkspace(root: string, version: string): WorkspacePaths {
  const recordings = join(root, 'recordings');

  let createdRoot = false;
  for (const dir of [root, recordings]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      if (dir === root) createdRoot = true;
    }
  }

  const templatesWritten = ensureWorkspaceTemplates(root, version);

  if (createdRoot) {
    console.log(chalk.green('  📁 已创建工作区目录: ' + root));
  }
  if (templatesWritten) {
    if (!createdRoot) {
      console.log(chalk.green('  📄 已更新工作区模板文件 (v' + version + '): ' + root));
    } else {
      console.log(chalk.green('  📄 已生成工作区模板文件 (v' + version + ')'));
    }
  }

  return { root, recordings };
}
