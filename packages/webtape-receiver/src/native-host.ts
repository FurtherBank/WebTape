/**
 * Native Messaging host entry point.
 *
 * Chrome spawns this process on-demand when the extension calls
 * chrome.runtime.connectNative('com.webtape.receiver').
 *
 * Protocol: each message is prefixed with a 4-byte little-endian length (uint32).
 * Chrome manages the process lifecycle; we exit after handling the message.
 */

import { resolveWorkspaceRoot, ensureWorkspace } from './workspace.js';
import { saveRecording } from './storage.js';
import { analyzeRecording } from './analyzer.js';
import { loadConfig } from './config.js';
import type { WebTapePayload } from './types.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const VERSION = '1.7.0';

function readNativeMessage(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerBuf = Buffer.alloc(0);
    let expectedLen: number | null = null;
    let body = Buffer.alloc(0);

    process.stdin.on('data', (chunk: Buffer) => {
      if (expectedLen === null) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        if (headerBuf.length >= 4) {
          expectedLen = headerBuf.readUInt32LE(0);
          body = headerBuf.slice(4);
        }
      } else {
        body = Buffer.concat([body, chunk]);
      }

      if (expectedLen !== null && body.length >= expectedLen) {
        resolve(body.slice(0, expectedLen));
      }
    });

    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      if (expectedLen === null || body.length < expectedLen) {
        reject(new Error('stdin closed before full message received'));
      }
    });
  });
}

function writeNativeMessage(obj: unknown): void {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

function getHostScriptPath(): string {
  return fileURLToPath(import.meta.url);
}

export async function runNativeHost(): Promise<void> {
  let payload: WebTapePayload;

  try {
    const raw = await readNativeMessage();
    const msg = JSON.parse(raw.toString('utf-8'));

    if (msg.type === 'ping') {
      writeNativeMessage({ type: 'pong', version: VERSION });
      process.exit(0);
    }

    if (msg.type !== 'recording') {
      writeNativeMessage({ type: 'error', error: `Unknown message type: ${msg.type}` });
      process.exit(1);
    }

    payload = msg.payload as WebTapePayload;
  } catch (err) {
    writeNativeMessage({ type: 'error', error: String(err) });
    process.exit(1);
  }

  let sessionDir: string;
  try {
    const workspaceRoot = resolveWorkspaceRoot();
    const workspace = ensureWorkspace(workspaceRoot, VERSION);
    sessionDir = saveRecording(workspace, payload);
    writeNativeMessage({ type: 'received', session: sessionDir });
  } catch (err) {
    writeNativeMessage({ type: 'error', error: String(err) });
    process.exit(1);
  }

  // Spawn a detached child process to run AI analysis so the native host
  // can exit immediately (Chrome does not need to keep it alive).
  const config = loadConfig();
  const backend = config.aiBackend ?? 'cursor';

  if (backend !== 'none') {
    try {
      const hostScript = getHostScriptPath();
      const child = spawn(
        process.execPath,
        [hostScript, '--analyze', sessionDir, '--backend', backend, ...(config.aiModel ? ['--model', config.aiModel] : [])],
        {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        },
      );
      child.unref();
    } catch (_err) {
      // Analysis spawn failure is non-fatal; data is already saved
    }
  }

  process.exit(0);
}

/**
 * Run analysis for a session directory (called from the detached subprocess).
 */
export async function runDetachedAnalysis(
  sessionDir: string,
  backend: string,
  model?: string,
): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const workspace = ensureWorkspace(workspaceRoot, VERSION);

  if (!existsSync(sessionDir)) {
    process.exit(1);
  }

  try {
    await analyzeRecording({
      backend: backend as 'cursor' | 'claude',
      workspace,
      sessionDir,
      model,
    });
  } catch (_err) {
    process.exit(1);
  }
  process.exit(0);
}
