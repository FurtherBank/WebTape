import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

1. **梳理用户操作流程**：根据 index.json 中的 action 序列，还原用户的完整操作路径。
2. **分析接口调用链路**：
   - 列出每个用户操作触发的所有 API 请求
   - 标注请求方法、URL、状态码
   - 分析请求之间的依赖关系（例如：登录后拿到 token，后续请求携带 token）
3. **识别业务模块**：根据 URL 模式和请求内容，划分业务模块（如：用户认证、数据查询、表单提交等）
4. **生成接口文档概要**：对每个接口给出简要说明，包括用途、请求参数、响应结构
5. **绘制链路图**：用 Mermaid 序列图描述核心业务流程的接口调用时序

## 数据结构

录制数据位于 \`recordings/<记录名>/\` 目录下，包含：
- \`index.json\` — 用户操作与网络请求时间线
- \`meta.json\` — 录制元数据
- \`requests/\` — 各请求的详细数据（请求头、请求体等）
- \`responses/\` — 各响应的详细数据（状态码、响应头、响应体等）

## 输出要求

请将分析报告输出为 Markdown 格式，保存到 \`recordings/<记录名>/analysis_report.md\`。
`;

/**
 * Ensure workspace template files (package.json, AGENTS.md) are up-to-date.
 * Re-writes them whenever the CLI version changes.
 */
function ensureWorkspaceTemplates(root: string, version: string): void {
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
  }
}

/**
 * Ensure the workspace directory tree exists and return the resolved paths.
 */
export function ensureWorkspace(root: string, version: string): WorkspacePaths {
  const recordings = join(root, 'recordings');

  for (const dir of [root, recordings]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  ensureWorkspaceTemplates(root, version);

  return { root, recordings };
}
