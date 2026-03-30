import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { WorkspacePaths } from "./workspace.js";

export type AnalyzerBackend = "cursor" | "claude" | "none";

export const VALID_BACKENDS: readonly AnalyzerBackend[] = [
  "cursor",
  "claude",
  "none",
] as const;

/**
 * Build the analysis instruction for a specific recording session.
 */
function buildInstruction(sessionName: string): string {
  return `"请先阅读 recordings/${sessionName}/_context.md 了解录制数据全貌，然后按照 AGENTS.md 中的指示完成分析，并将报告文件保存到对应位置。如需查看被截断的完整请求/响应体，请查阅 requests/ 和 responses/ 目录下的原始文件。"`;
}

export interface AnalyzeOptions {
  backend: AnalyzerBackend;
  workspace: WorkspacePaths;
  sessionDir: string;
  model?: string;
  /** Callback for real-time log output */
  onLog?: (line: string) => void;
}

export interface AnalyzeResult {
  /** Whether the analysis report was successfully created */
  success: boolean;
  /** Expected report path */
  reportPath: string;
  /** Session name */
  sessionName: string;
  /** Analysis duration in milliseconds */
  duration?: number;
}

/**
 * Run AI analysis on a recording session.
 * Returns an AnalyzeResult indicating whether the report was created.
 */
export async function analyzeRecording(
  opts: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const { backend, workspace, sessionDir, model } = opts;

  const sessionName = relative(workspace.recordings, sessionDir);
  const reportPath = join(
    workspace.recordings,
    sessionName,
    "analysis_report.md",
  );

  const startTime = Date.now();
  if (backend === "cursor") {
    await runCursor(workspace.root, sessionName, model, opts.onLog);
  } else if (backend === "claude") {
    await runClaude(workspace.root, sessionName, opts.onLog);
  } else {
    throw new Error(`Unsupported analyzer backend: ${backend}`);
  }
  const duration = Date.now() - startTime;

  const success = existsSync(reportPath);
  return { success, reportPath, sessionName, duration };
}

/**
 * Run analysis via `cursor agent` CLI.
 * cwd is the workspace root so cursor reads AGENTS.md.
 */
async function runCursor(
  workspaceRoot: string,
  sessionName: string,
  model?: string,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const instruction = buildInstruction(sessionName);
    const args = ["agent", instruction, "--print", "--trust", "--yolo"];

    if (model) {
      args.push("--model", model);
    }

    const child = execFile(
      "cursor",
      args,
      {
        cwd: workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      },
      (error, _stdout, stderr) => {
        if (error) {
          if (stderr) {
            console.error("[analyzer] cursor stderr:", stderr);
          }
          reject(new Error(`cursor agent failed: ${error.message}`));
          return;
        }
        resolve();
      },
    );

    if (onLog) {
      child.stdout?.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) onLog(line.trim());
        }
      });
      child.stderr?.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) onLog(line.trim());
        }
      });
    }

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to launch cursor agent: ${err.message}. ` +
            "Ensure Cursor is installed and the `cursor` CLI is on your PATH.",
        ),
      );
    });
  });
}

/**
 * Run analysis via `claude` CLI (Claude Code).
 * cwd is the workspace root so claude reads AGENTS.md.
 */
async function runClaude(
  workspaceRoot: string,
  sessionName: string,
  onLog?: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const instruction = buildInstruction(sessionName);
    const args = ["-p", instruction];

    const child = execFile(
      "claude",
      args,
      {
        cwd: workspaceRoot,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
      },
      (error, _stdout, stderr) => {
        if (error) {
          if (stderr) {
            console.error("[analyzer] claude stderr:", stderr);
          }
          reject(new Error(`claude failed: ${error.message}`));
          return;
        }
        resolve();
      },
    );

    if (onLog) {
      child.stdout?.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) onLog(line.trim());
        }
      });
      child.stderr?.on("data", (data) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line.trim()) onLog(line.trim());
        }
      });
    }

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to launch claude: ${err.message}. ` +
            "Ensure Claude Code is installed and the `claude` CLI is on your PATH.",
        ),
      );
    });
  });
}
