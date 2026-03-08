import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';
import type { WebTapePayload } from './types.js';

/**
 * Extract the registered domain (一级域名) from a URL string.
 * e.g. "https://www.github.com/page" → "github.com"
 */
export function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const clean = hostname.replace(/^www\./, '');
    // IP addresses: keep as-is
    if (/^\d+\.\d+\.\d+\.\d+$/.test(clean)) {
      return clean;
    }
    // Get registered domain
    const parts = clean.split('.');
    if (parts.length <= 2) return clean;
    // Common multi-part TLDs (e.g. co.uk, com.cn, co.jp, etc.)
    const multiPartTlds = ['co.uk', 'com.cn', 'com.au', 'co.jp', 'co.kr', 'com.br', 'com.tw', 'com.hk', 'org.uk', 'net.au'];
    const lastTwo = parts.slice(-2).join('.');
    if (multiPartTlds.includes(lastTwo) && parts.length > 2) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch {
    return 'unknown';
  }
}

/**
 * Find the primary site URL from the payload's index.json timeline.
 * Uses the first context block that has a state with a URL.
 */
function extractSiteUrl(payload: WebTapePayload): string {
  for (const block of payload.content['index.json']) {
    if (block.state?.url) return block.state.url;
  }
  return '';
}

/**
 * Build the session directory name from the payload.
 * Format: ${domain}-${MMDD}-${HHmmss}
 * e.g. "github.com-0305-123000"
 */
function sessionDirName(payload: WebTapePayload): string {
  const d = new Date(payload.meta.epoch);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');

  const domain = extractDomain(extractSiteUrl(payload)) || 'unknown';
  const datePart = `${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  return `${domain}-${datePart}-${timePart}`;
}

/**
 * Parse a session directory name back into its components.
 * Format: ${domain}-${MMDD}-${HHmmss}
 */
export function parseSessionName(name: string): { domain: string; date: string; time: string } {
  const lastDash = name.lastIndexOf('-');
  const time = name.slice(lastDash + 1);
  const rest = name.slice(0, lastDash);
  const secondLastDash = rest.lastIndexOf('-');
  const date = rest.slice(secondLastDash + 1);
  const domain = rest.slice(0, secondLastDash);
  return { domain, date, time };
}

/**
 * Format a time string "HHmmss" → "HH:mm:ss".
 */
export function formatTime(time: string): string {
  if (time.length !== 6) return time;
  return `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
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

/**
 * Check whether a recording session has an analysis report.
 */
export function hasAnalysisReport(workspace: WorkspacePaths, sessionName: string): boolean {
  return existsSync(join(workspace.recordings, sessionName, 'analysis_report.md'));
}

/**
 * List recordings that do NOT have an analysis report.
 */
export function listUnanalyzedRecordings(workspace: WorkspacePaths): string[] {
  return listRecordings(workspace).filter((name) => !hasAnalysisReport(workspace, name));
}
