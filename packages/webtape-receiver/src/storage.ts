import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';
import type { WebTapePayload, SavedIndexFile, SavedContextBlock } from './types.js';
import { extractSiteUrl, renderAnalysisContext } from './context.js';

/**
 * Format a unix-ms timestamp as a local-timezone ISO string with milliseconds.
 * e.g. 1742460645123 → "2026-03-20T14:30:45.123+08:00"
 */
function formatLocalTimestamp(ts: number): string {
  const d = new Date(ts);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const tzHH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const tzMM = String(absMin % 60).padStart(2, '0');
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${tzHH}:${tzMM}`
  );
}

/**
 * Extract the full hostname from a URL string.
 * e.g. "https://www.github.com/page" → "www.github.com"
 */
export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Build the session directory name from the payload.
 * Format: ${hostname}/${MMDD}-${HHmmss}
 * e.g. "www.github.com/0305-123000"
 */
function sessionDirName(payload: WebTapePayload): string {
  const firstTs = payload.content['index.json'][0]?.timestamp ?? Date.now();
  const d = new Date(firstTs);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');

  const hostname = extractHostname(extractSiteUrl(payload)) || 'unknown';
  const datePart = `${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  return `${hostname}/${datePart}-${timePart}`;
}

/**
 * Parse a session directory name back into its components.
 * New format: ${hostname}/${MMDD}-${HHmmss}
 * Legacy format: ${domain}-${MMDD}-${HHmmss}
 */
export function parseSessionName(name: string): { domain: string; date: string; time: string } {
  const slashIdx = name.lastIndexOf('/');
  if (slashIdx !== -1) {
    // New format: hostname/MMDD-HHmmss
    const domain = name.slice(0, slashIdx);
    const timePart = name.slice(slashIdx + 1);
    const dashIdx = timePart.indexOf('-');
    if (dashIdx !== -1) {
      return { domain, date: timePart.slice(0, dashIdx), time: timePart.slice(dashIdx + 1) };
    }
    return { domain, date: timePart, time: '' };
  }
  // Legacy format: domain-MMDD-HHmmss
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
 * If `body` is a JSON string, parse it into an object so it is saved as
 * nested JSON rather than an escaped string.
 */
function withParsedJsonBody<T extends { body?: unknown }>(entry: T): T {
  if (typeof entry.body === 'string') {
    try {
      const parsed = JSON.parse(entry.body);
      if (typeof parsed === 'object' && parsed !== null) {
        return { ...entry, body: parsed };
      }
    } catch {
      // not valid JSON – keep the original string
    }
  }
  return entry;
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
  const snapshotDir = join(sessionDir, 'snapshots');

  mkdirSync(reqDir, { recursive: true });
  mkdirSync(resDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });

  // Create a mapping of original req_id to sequential ID (0001, 0002, ...)
  const allReqIds = Object.keys(payload.content.requests)
    .map(filename => filename.replace('_body.json', ''))
    .sort((a, b) => {
      // Extract timestamp from req_id (e.g., req_0001_1773381143117)
      const tA = parseInt(a.split('_').pop() || '0', 10);
      const tB = parseInt(b.split('_').pop() || '0', 10);
      return tA - tB;
    });

  const idMap = new Map<string, string>();
  allReqIds.forEach((oldId, index) => {
    idMap.set(oldId, String(index + 1).padStart(4, '0'));
  });

  // Update index.json: remap req_ids and keep detail_path in sync
  const updatedIndex = payload.content['index.json'].map(block => ({
    ...block,
    triggered_network: block.triggered_network?.map(net => {
      const newId = idMap.get(net.req_id) || net.req_id;
      return {
        ...net,
        req_id: newId,
        detail_path: {
          request: `requests/req_${newId}_body.json`,
          response: `responses/req_${newId}_res.json`,
        },
      };
    }),
  }));

  const savedTimeline: SavedContextBlock[] = updatedIndex.map((block) => ({
    ...block,
    timestamp: formatLocalTimestamp(block.timestamp),
  }));
  const savedIndex: SavedIndexFile = {
    meta: { version: payload.meta.version },
    timeline: savedTimeline,
  };
  writeFileSync(
    join(sessionDir, 'index.json'),
    JSON.stringify(savedIndex, null, 2),
    'utf-8',
  );

  for (const [filename, data] of Object.entries(payload.content.requests)) {
    const oldId = filename.replace('_body.json', '');
    const newId = idMap.get(oldId) || oldId;
    const newFilename = `req_${newId}_body.json`;
    
    // Add original timestamp/id to data for reference
    const enrichedData = { ...withParsedJsonBody(data), _original_id: oldId };

    writeFileSync(
      join(reqDir, newFilename),
      JSON.stringify(enrichedData, null, 2),
      'utf-8',
    );
  }

  for (const [filename, data] of Object.entries(payload.content.responses)) {
    const oldId = filename.replace('_res.json', '');
    const newId = idMap.get(oldId) || oldId;
    const newFilename = `req_${newId}_res.json`;

    writeFileSync(
      join(resDir, newFilename),
      JSON.stringify(withParsedJsonBody(data), null, 2),
      'utf-8',
    );
  }

  if (payload.content.snapshots) {
    for (const [contextId, snapshotText] of Object.entries(payload.content.snapshots)) {
      writeFileSync(
        join(snapshotDir, `snapshot_${contextId}.md`),
        snapshotText,
        'utf-8',
      );
    }
  }

  const siteUrl = extractSiteUrl(payload);
  writeFileSync(
    join(sessionDir, '_context.md'),
    renderAnalysisContext(payload, siteUrl),
    'utf-8',
  );

  return sessionDir;
}

/**
 * List existing recording sessions sorted newest-first.
 * Supports both new format (hostname/MMDD-HHmmss) and legacy flat format.
 */
export function listRecordings(workspace: WorkspacePaths): string[] {
  try {
    const results: string[] = [];
    const topDirs = readdirSync(workspace.recordings, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    for (const dir of topDirs) {
      const dirPath = join(workspace.recordings, dir.name);

      // Legacy flat format: session dir contains index.json directly
      if (existsSync(join(dirPath, 'index.json'))) {
        results.push(dir.name);
        continue;
      }

      // New format: hostname dir contains session subdirectories
      const subDirs = readdirSync(dirPath, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const sub of subDirs) {
        if (existsSync(join(dirPath, sub.name, 'index.json'))) {
          results.push(`${dir.name}/${sub.name}`);
        }
      }
    }

    // Sort by date-time newest-first
    results.sort((a, b) => {
      const aParsed = parseSessionName(a);
      const bParsed = parseSessionName(b);
      const aKey = `${aParsed.date}-${aParsed.time}`;
      const bKey = `${bParsed.date}-${bParsed.time}`;
      return bKey.localeCompare(aKey);
    });

    return results;
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
