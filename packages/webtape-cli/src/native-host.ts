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

/**
 * Write a native message, then wait for Chrome to send SIGTERM before exiting.
 *
 * Why SIGTERM, not stdin EOF:
 *   Chrome uses connectNative() (persistent port). After sending a message,
 *   Chrome immediately half-closes stdin (closes the write-end of the pipe).
 *   This fires Node.js's stdin 'end'/'close' events right after the message
 *   is read — BEFORE Chrome has had a chance to deliver our stdout response
 *   to the extension's onMessage handler.
 *
 *   Exiting on stdin 'end' therefore races with Chrome's message delivery,
 *   causing onDisconnect("Native host has exited.") to win over onMessage.
 *
 * Correct lifecycle with SIGTERM:
 *   1. Host writes response → stays alive.
 *   2. Chrome reads response from stdout → delivers to extension onMessage.
 *   3. Extension onMessage fires → extension calls port.disconnect().
 *   4. Chrome sends SIGTERM to the host process.
 *   5. Host receives SIGTERM → exits cleanly.
 *   6. Chrome fires onDisconnect with lastError = null (extension-initiated).
 *
 * Why the timer must be registered synchronously (before stdout.write):
 *   stdin reaches EOF as soon as Chrome half-closes its write-end. If we only
 *   set up the safety timer inside the stdout.write callback (async), there is
 *   a window where stdin EOF has already drained the event loop before the
 *   callback fires — the process exits before SIGTERM ever arrives.
 *   Registering the timer synchronously guarantees the event loop is held open
 *   regardless of the stdin EOF / stdout flush ordering.
 *
 *   The timer is intentionally NOT unref()'d: we need it to hold the event
 *   loop open while waiting for Chrome's SIGTERM. process.exit() in the SIGTERM
 *   handler terminates the process immediately, clearing the timer.
 */
function writeNativeMessageAndExit(obj: unknown, code: number): void {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);

  const doExit = () => process.exit(code);

  // Register SIGTERM and safety timer synchronously — before the async write —
  // so the event loop stays alive even if stdin EOF fires before the callback.
  process.once('SIGTERM', doExit);
  // Safety: exit after 30s if SIGTERM never arrives (e.g. extension crashed).
  // Must NOT be unref()'d: this timer is the sole event loop reference after
  // stdin reaches EOF.
  setTimeout(doExit, 30_000);

  process.stdout.write(Buffer.concat([header, buf]));
}

function getHostScriptPath(): string {
  return fileURLToPath(import.meta.url);
}

export async function runNativeHost(): Promise<void> {
  // stdout is exclusively reserved for the 4-byte-prefixed native messaging
  // protocol. Any stray bytes (console.log, chalk output, npm install progress,
  // etc.) corrupt the stream and trigger Chrome's
  // "Error when communicating with the native messaging host."
  // Redirect all console output to stderr for the lifetime of this process.
  console.log   = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n');
  console.info  = console.log;
  console.debug = console.log;
  console.warn  = (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n');

  let payload: WebTapePayload;

  try {
    const raw = await readNativeMessage();
    const msg = JSON.parse(raw.toString('utf-8'));

    if (msg.type === 'ping') {
      writeNativeMessageAndExit({ type: 'pong', version: VERSION }, 0);
      return;
    }

    if (msg.type !== 'recording') {
      writeNativeMessageAndExit({ type: 'error', error: `Unknown message type: ${msg.type}` }, 1);
      return;
    }

    payload = msg.payload as WebTapePayload;
  } catch (err) {
    writeNativeMessageAndExit({ type: 'error', error: String(err) }, 1);
    return;
  }

  let sessionDir: string;
  try {
    const workspaceRoot = resolveWorkspaceRoot();
    const workspace = ensureWorkspace(workspaceRoot, VERSION);
    sessionDir = saveRecording(workspace, payload);
  } catch (err) {
    writeNativeMessageAndExit({ type: 'error', error: String(err) }, 1);
    return;
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

  writeNativeMessageAndExit({ type: 'received', session: sessionDir }, 0);
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
