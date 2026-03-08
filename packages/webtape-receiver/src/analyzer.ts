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
export function buildPrompt(sessionDir: string): string {
  const indexPath = join(sessionDir, 'index.json');
  if (!existsSync(indexPath)) {
    throw new Error(`index.json not found in ${sessionDir}`);
  }
  const indexContent = readFileSync(indexPath, 'utf-8');

  return ANALYSIS_PROMPT_TEMPLATE
    .replace('{{INDEX_JSON}}', indexContent)
    .replace('{{SESSION_DIR}}', sessionDir);
}

export type AnalyzerBackend = 'cursor' | 'claude';

export const VALID_BACKENDS: readonly AnalyzerBackend[] = ['cursor', 'claude'] as const;

const ANALYSIS_INSTRUCTION = '请阅读当前目录下的 prompt.md 文件，按照其中的指示完成分析任务，并将分析报告输出为 Markdown 格式。';

export interface AnalyzeOptions {
  backend: AnalyzerBackend;
  workspace: WorkspacePaths;
  sessionDir: string;
  model?: string;
}

/**
 * Run AI analysis on a recording session.
 * Returns the path to the generated analysis report.
 */
export async function analyzeRecording(opts: AnalyzeOptions): Promise<string> {
  const { backend, workspace, sessionDir, model } = opts;

  const sessionName = sessionDir.split('/').pop() || 'unknown';
  const reportPath = join(workspace.analyses, `${sessionName}.md`);

  // Ensure prompt.md exists in the session directory (backward compatibility)
  const promptPath = join(sessionDir, 'prompt.md');
  if (!existsSync(promptPath)) {
    const prompt = buildPrompt(sessionDir);
    writeFileSync(promptPath, prompt, 'utf-8');
  }

  if (backend === 'cursor') {
    return analyzeByCursor(sessionDir, reportPath, model);
  }

  if (backend === 'claude') {
    return analyzeByClaude(sessionDir, reportPath);
  }

  throw new Error(`Unsupported analyzer backend: ${backend}`);
}

/**
 * Analyze via `cursor agent` CLI.
 * The prompt is read from prompt.md in the session directory.
 * Command: cursor agent prompt "<instruction>" --model "<model>"
 */
async function analyzeByCursor(
  sessionDir: string,
  reportPath: string,
  model?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [
      'agent',
      ANALYSIS_INSTRUCTION, '--yolo'
    ];

    if (model) {
      args.push('--model', model);
    }

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
 * Analyze via `claude` CLI (Claude Code).
 * Command: claude "<instruction>" --dangerously-skip-permissions
 */
async function analyzeByClaude(
  sessionDir: string,
  reportPath: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = [ANALYSIS_INSTRUCTION, '--dangerously-skip-permissions'];

    const child = execFile('claude', args, {
      cwd: sessionDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    }, (error, stdout, stderr) => {
      if (error) {
        if (stderr) {
          console.error('[analyzer] claude stderr:', stderr);
        }
        reject(new Error(`claude failed: ${error.message}`));
        return;
      }

      const output = stdout || '';
      writeFileSync(reportPath, output, 'utf-8');
      resolve(reportPath);
    });

    child.on('error', (err) => {
      reject(new Error(
        `Failed to launch claude: ${err.message}. ` +
        'Ensure Claude Code is installed and the `claude` CLI is on your PATH.',
      ));
    });
  });
}

/**
 * Generate (or refresh) the prompt.md file inside the session directory
 * for manual use (e.g. paste into Cursor chat).
 */
export function generatePromptFile(
  sessionDir: string,
): string {
  const promptPath = join(sessionDir, 'prompt.md');
  const prompt = buildPrompt(sessionDir);
  writeFileSync(promptPath, prompt, 'utf-8');
  return promptPath;
}
