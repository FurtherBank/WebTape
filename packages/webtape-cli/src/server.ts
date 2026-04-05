import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';
import type { WebTapePayload } from './types.js';
import { saveRecording } from './storage.js';
import { analyzeRecording, type AnalyzerBackend, type AnalyzeResult } from './analyzer.js';

/** 单次 webhook 收包后、启动 AI 之前的处理耗时（接收/解析 + 落盘与生成 _context.md） */
export interface ReceivePersistMetrics {
  /** 读取 HTTP 正文 */
  readBodyMs: number;
  /** JSON.parse 与 meta/content 校验 */
  parseValidateMs: number;
  /** saveRecording：写 requests/responses/snapshots/index.json 与 _context.md */
  persistMs: number;
  /** 以上三项之和，即非 AI 链路总耗时 */
  totalNonAiMs: number;
}

export interface ServerOptions {
  port: number;
  workspace: WorkspacePaths;
  autoAnalyze: boolean;
  analyzerBackend: AnalyzerBackend;
  analyzerModel?: string;
  onReceive?: (sessionDir: string, payload: WebTapePayload, metrics: ReceivePersistMetrics) => void;
  onAnalyzeLog?: (line: string) => void;
  onAnalyzeDone?: (result: AnalyzeResult) => void;
  onError?: (err: Error) => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }
  return false;
}

export function createWebhookServer(opts: ServerOptions) {
  const { port, workspace, autoAnalyze, analyzerBackend, analyzerModel, onReceive, onAnalyzeLog, onAnalyzeDone, onError } = opts;

  const server = createServer(async (req, res) => {
    if (handleCors(req, res)) return;

    // Health check
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      json(res, 200, {
        status: 'ok',
        service: 'webtape',
        workspace: workspace.root,
      });
      return;
    }

    // Webhook endpoint
    if (req.method === 'POST' && (req.url === '/' || req.url === '/webhook')) {
      try {
        const t0 = performance.now();
        const body = await readBody(req);
        const t1 = performance.now();
        const payload: WebTapePayload = JSON.parse(body);

        if (!payload.meta || !payload.content) {
          json(res, 400, { error: 'Invalid WebTape payload: missing meta or content' });
          return;
        }

        const t2 = performance.now();
        const sessionDir = saveRecording(workspace, payload);
        const t3 = performance.now();

        const metrics: ReceivePersistMetrics = {
          readBodyMs: t1 - t0,
          parseValidateMs: t2 - t1,
          persistMs: t3 - t2,
          totalNonAiMs: t3 - t0,
        };

        onReceive?.(sessionDir, payload, metrics);

        if (autoAnalyze) {
          runAnalysis(workspace, sessionDir, analyzerBackend, analyzerModel, onAnalyzeLog, onAnalyzeDone, onError);
        }

        json(res, 200, {
          status: 'received',
          session: sessionDir,
          autoAnalyze,
          timingMs: {
            readBody: Math.round(metrics.readBodyMs * 10) / 10,
            parseValidate: Math.round(metrics.parseValidateMs * 10) / 10,
            persist: Math.round(metrics.persistMs * 10) / 10,
            totalNonAi: Math.round(metrics.totalNonAiMs * 10) / 10,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(err instanceof Error ? err : new Error(message));
        json(res, 500, { error: message });
      }
      return;
    }

    // Trigger analysis for a specific session
    if (req.method === 'POST' && req.url?.startsWith('/analyze/')) {
      const sessionName = req.url.slice('/analyze/'.length);
      const sessionDir = join(workspace.recordings, sessionName);
      try {
        runAnalysis(workspace, sessionDir, analyzerBackend, analyzerModel, onAnalyzeLog, onAnalyzeDone, onError);
        json(res, 200, { status: 'analysis_started', session: sessionDir });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: message });
      }
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  return {
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    server,
  };
}

function runAnalysis(
  workspace: WorkspacePaths,
  sessionDir: string,
  backend: AnalyzerBackend,
  model: string | undefined,
  onLog?: (line: string) => void,
  onDone?: (result: AnalyzeResult) => void,
  onError?: (err: Error) => void,
) {
  analyzeRecording({ backend, workspace, sessionDir, model, onLog })
    .then((result) => onDone?.(result))
    .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))));
}
