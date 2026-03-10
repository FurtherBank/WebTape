import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';
import type { WebTapePayload } from './types.js';
import { saveRecording } from './storage.js';
import { analyzeRecording, type AnalyzerBackend, type AnalyzeResult } from './analyzer.js';

export interface ServerOptions {
  port: number;
  workspace: WorkspacePaths;
  autoAnalyze: boolean;
  analyzerBackend: AnalyzerBackend;
  analyzerModel?: string;
  onReceive?: (sessionDir: string, payload: WebTapePayload) => void;
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
        service: 'webtape-receiver',
        workspace: workspace.root,
      });
      return;
    }

    // Webhook endpoint
    if (req.method === 'POST' && (req.url === '/' || req.url === '/webhook')) {
      try {
        const body = await readBody(req);
        const payload: WebTapePayload = JSON.parse(body);

        if (!payload.meta || !payload.content) {
          json(res, 400, { error: 'Invalid WebTape payload: missing meta or content' });
          return;
        }

        const sessionDir = saveRecording(workspace, payload);
        onReceive?.(sessionDir, payload);

        if (autoAnalyze) {
          runAnalysis(workspace, sessionDir, analyzerBackend, analyzerModel, onAnalyzeLog, onAnalyzeDone, onError);
        }

        json(res, 200, {
          status: 'received',
          session: sessionDir,
          autoAnalyze,
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
