import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';
import type { WebTapePayload } from './types.js';

/**
 * Build a human-readable session directory name from the payload metadata.
 * Format: YYYY-MM-DD_HH-mm-ss
 */
function sessionDirName(payload: WebTapePayload): string {
  const d = new Date(payload.meta.epoch);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join('-') + '_' + [
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('-');
}

/**
 * Persist a webhook payload to the workspace as structured files:
 *
 *   recordings/<session>/
 *     index.json
 *     requests/
 *       req_0001_body.json
 *     responses/
 *       req_0001_res.json
 *
 * Returns the absolute path of the session directory.
 */
export function saveRecording(
  workspace: WorkspacePaths,
  payload: WebTapePayload,
): string {
  const dirName = sessionDirName(payload);
  const sessionDir = join(workspace.recordings, dirName);
  const reqDir = join(sessionDir, 'requests');
  const resDir = join(sessionDir, 'responses');

  mkdirSync(reqDir, { recursive: true });
  mkdirSync(resDir, { recursive: true });

  writeFileSync(
    join(sessionDir, 'index.json'),
    JSON.stringify(payload.content['index.json'], null, 2),
    'utf-8',
  );

  for (const [filename, data] of Object.entries(payload.content.requests)) {
    writeFileSync(
      join(reqDir, filename),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  }

  for (const [filename, data] of Object.entries(payload.content.responses)) {
    writeFileSync(
      join(resDir, filename),
      JSON.stringify(data, null, 2),
      'utf-8',
    );
  }

  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify(payload.meta, null, 2),
    'utf-8',
  );

  return sessionDir;
}

/**
 * List existing recording sessions (directory names) sorted newest-first.
 */
export function listRecordings(workspace: WorkspacePaths): string[] {
  try {
    return readdirSync(workspace.recordings, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
