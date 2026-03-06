import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';

const ANALYSIS_PROMPT_TEMPLATE = `你是一个专业的 Web 前端业务分析专家。请根据以下 WebTape 录制数据，分析该网页的业务逻辑和完整接口链路。

## 任务

1. **梳理用户操作流程**：根据 index.json 中的 action 序列，还原用户的完整操作路径。
2. **分析接口调用链路**：
   - 列出每个用户操作触发的所有 API 请求
   - 标注请求方法、URL、状态码
   - 分析请求之间的依赖关系（例如：登录后拿到 token，后续请求携带 token）
3. **识别业务模块**：根据 URL 模式和请求内容，划分业务模块（如：用户认证、数据查询、表单提交等）
4. **生成接口文档概要**：对每个接口给出简要说明，包括用途、请求参数、响应结构
5. **绘制链路图**：用 Mermaid 序列图描述核心业务流程的接口调用时序

## 录制数据

以下是 WebTape 录制的 index.json 内容：

\`\`\`json
{{INDEX_JSON}}
\`\`\`

## 请求详情目录

录制的请求详情文件位于：{{SESSION_DIR}}

请详细分析并输出 Markdown 格式的报告。`;

/**
 * Build the analysis prompt from a recording session.
 */
function buildPrompt(sessionDir: string): string {
  const indexPath = join(sessionDir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`index.json not found in ${sessionDir}`);
  }
  const indexContent = readFileSync(indexPath, 'utf-8');

  return ANALYSIS_PROMPT_TEMPLATE
    .replace('{{INDEX_JSON}}', indexContent)
    .replace('{{SESSION_DIR}}', sessionDir);
}

export type AnalyzerBackend = 'cursor';

export interface AnalyzeOptions {
  backend: AnalyzerBackend;
  workspace: WorkspacePaths;
  sessionDir: string;
}

/**
 * Run AI analysis on a recording session.
 * Returns the path to the generated analysis report.
 */
export async function analyzeRecording(opts: AnalyzeOptions): Promise<string> {
  const { backend, workspace, sessionDir } = opts;

  const sessionName = sessionDir.split('/').pop() || 'unknown';
  const reportPath = join(workspace.analyses, `${sessionName}.md`);
  const prompt = buildPrompt(sessionDir);

  if (backend === 'cursor') {
    return analyzeByCursor(prompt, sessionDir, reportPath);
  }

  throw new Error(`Unsupported analyzer backend: ${backend}`);
}

/**
 * Analyze via `cursor agent` CLI.
 * Writes the prompt to a temp file and invokes cursor in agent mode.
 */
async function analyzeByCursor(
  prompt: string,
  sessionDir: string,
  reportPath: string,
): Promise<string> {
  const promptPath = join(sessionDir, '.analysis_prompt.md');
  writeFileSync(promptPath, prompt, 'utf-8');

  return new Promise<string>((resolve, reject) => {
    const args = [
      'agent',
      '--message', prompt,
    ];

    const child = execFile('cursor', args, {
      cwd: sessionDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    }, (error, stdout, stderr) => {
      if (error) {
        if (stderr) {
          console.error('[analyzer] cursor stderr:', stderr);
        }
        reject(new Error(`cursor agent failed: ${error.message}`));
        return;
      }

      const output = stdout || '';
      writeFileSync(reportPath, output, 'utf-8');
      resolve(reportPath);
    });

    child.on('error', (err) => {
      reject(new Error(
        `Failed to launch cursor agent: ${err.message}. ` +
        'Ensure Cursor is installed and the `cursor` CLI is on your PATH.',
      ));
    });
  });
}

/**
 * Generate a standalone prompt file for manual use (e.g. paste into Cursor chat).
 */
export function generatePromptFile(
  workspace: WorkspacePaths,
  sessionDir: string,
): string {
  const sessionName = sessionDir.split('/').pop() || 'unknown';
  const promptPath = join(workspace.analyses, `${sessionName}_prompt.md`);
  const prompt = buildPrompt(sessionDir);
  writeFileSync(promptPath, prompt, 'utf-8');
  return promptPath;
}
