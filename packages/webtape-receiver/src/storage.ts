import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspacePaths } from './workspace.js';
import type { WebTapePayload, ContextBlock, NetworkSummary, RequestEntry, ResponseEntry } from './types.js';

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
 * Format: ${hostname}/${MMDD}-${HHmmss}
 * e.g. "www.github.com/0305-123000"
 */
function sessionDirName(payload: WebTapePayload): string {
  const d = new Date(payload.meta.epoch);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');

  const hostname = payload.meta.hostname || extractHostname(extractSiteUrl(payload)) || 'unknown';
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
      JSON.stringify(withParsedJsonBody(data), null, 2),
      'utf-8',
    );
  }

  for (const [filename, data] of Object.entries(payload.content.responses)) {
    writeFileSync(
      join(resDir, filename),
      JSON.stringify(withParsedJsonBody(data), null, 2),
      'utf-8',
    );
  }

  writeFileSync(
    join(sessionDir, 'meta.json'),
    JSON.stringify(payload.meta, null, 2),
    'utf-8',
  );

  generateAnalysisContext(sessionDir, payload);

  return sessionDir;
}

// ---------------------------------------------------------------------------
// Analysis context generation
// ---------------------------------------------------------------------------

const NOISE_HEADERS = new Set([
  'accept-encoding', 'accept-language', 'cache-control', 'connection',
  'content-length', 'dnt', 'etag', 'if-modified-since', 'if-none-match',
  'keep-alive', 'pragma', 'server', 'vary', 'date', 'age', 'expires',
  'last-modified', 'transfer-encoding', 'x-powered-by', 'x-request-id',
  'x-frame-options', 'x-content-type-options', 'x-xss-protection',
]);

const NOISE_HEADER_PREFIXES = [
  'sec-', 'content-security-policy', 'strict-transport-security',
  'access-control-', 'permissions-policy', 'cross-origin-',
  'report-to', 'nel', ':',
];

const BODY_FULL_LIMIT = 2000;
const BODY_PREVIEW_LIMIT = 500;

function isNoiseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (NOISE_HEADERS.has(lower)) return true;
  return NOISE_HEADER_PREFIXES.some((p) => lower.startsWith(p));
}

function renderHeaders(headers: Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (isNoiseHeader(key)) continue;
    const lower = key.toLowerCase();
    if (lower === 'cookie') {
      const names = value.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
      lines.push(`${key}: [${names.length} cookies: ${names.join(', ')}]`);
    } else if (lower === 'set-cookie') {
      lines.push(`${key}: [set-cookie present]`);
    } else {
      lines.push(`${key}: ${value.length > 300 ? value.slice(0, 300) + '…' : value}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function renderBody(body: unknown): { text: string; lang: string; byteSize: number; truncated: boolean } | null {
  if (body == null) return null;
  let text: string;
  let lang = '';

  if (typeof body === 'string') {
    text = body;
    if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
        lang = 'json';
      } catch { /* not JSON */ }
    }
  } else {
    text = JSON.stringify(body, null, 2);
    lang = 'json';
  }

  const byteSize = Buffer.byteLength(text, 'utf-8');
  if (text.length <= BODY_FULL_LIMIT) {
    return { text, lang, byteSize, truncated: false };
  }
  return { text: text.slice(0, BODY_PREVIEW_LIMIT) + '\n…(truncated)', lang, byteSize, truncated: true };
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function describeBlock(block: ContextBlock): string {
  if (block.action) {
    const tag = block.action.tag || '';
    const label = block.action.aria_label || block.action.id || block.action.target_element || '';
    return `用户操作: ${block.action.type} ${tag}${label ? ' "' + label + '"' : ''}`;
  }
  if (block.state) {
    return `页面状态: ${block.state.title || block.state.url}`;
  }
  return `上下文 ${block.context_id}`;
}

function pushNetworkEntry(
  lines: string[],
  net: NetworkSummary,
  requests: Record<string, RequestEntry>,
  responses: Record<string, ResponseEntry>,
): void {
  const reqKey = `${net.req_id}_body.json`;
  const resKey = `${net.req_id}_res.json`;
  const reqData = requests[reqKey];
  const resData = responses[resKey];

  const sizeHint = net.response_body_bytes != null ? ` (${fmtBytes(net.response_body_bytes)})` : '';
  lines.push(`#### ${net.method} ${net.url} → ${net.status ?? '?'}${sizeHint}`);
  lines.push('');

  if (reqData) {
    const hdr = renderHeaders(reqData.headers);
    if (hdr) {
      lines.push('请求头:');
      lines.push('```');
      lines.push(hdr);
      lines.push('```');
    }
    const body = renderBody(reqData.body);
    if (body) {
      const sizeNote = body.truncated ? ` (${fmtBytes(body.byteSize)}, 已截断)` : '';
      lines.push(`请求体${sizeNote}:`);
      lines.push('```' + body.lang);
      lines.push(body.text);
      lines.push('```');
    }
  }

  if (resData) {
    const hdr = renderHeaders(resData.headers);
    if (hdr) {
      lines.push('响应头:');
      lines.push('```');
      lines.push(hdr);
      lines.push('```');
    }
    const body = renderBody(resData.body);
    if (body) {
      const sizeNote = body.truncated ? ` (${fmtBytes(body.byteSize)}, 已截断)` : '';
      lines.push(`响应体${sizeNote}:`);
      lines.push('```' + body.lang);
      lines.push(body.text);
      lines.push('```');
    }
  }

  lines.push('');
}

function generateAnalysisContext(sessionDir: string, payload: WebTapePayload): void {
  const lines: string[] = [];
  const timeline = payload.content['index.json'];
  const requests = payload.content.requests;
  const responses = payload.content.responses;

  lines.push('# 录制数据分析上下文');
  lines.push('');
  lines.push('> 此文件由 webtape-receiver 自动生成，将录制的时间线、请求和响应整合为单一文档。');
  lines.push('> 已过滤无关请求头（缓存、安全策略、编码等），超大 body 已截断。如需完整数据请查阅 requests/ 和 responses/ 目录。');
  lines.push('');

  lines.push('## 元数据');
  lines.push('');
  lines.push(`- 录制时间: ${payload.meta.timestamp}`);
  if (payload.meta.hostname) {
    lines.push(`- 网站: ${payload.meta.hostname}`);
  }
  const siteUrl = extractSiteUrl(payload);
  if (siteUrl) {
    lines.push(`- 入口 URL: ${siteUrl}`);
  }
  lines.push(`- 时间线条目: ${timeline.length}`);
  lines.push(`- 请求总数: ${Object.keys(requests).length}`);
  lines.push('');

  // Track which req_ids appear in the timeline
  const referencedReqIds = new Set<string>();

  lines.push('## 操作时间线与接口详情');
  lines.push('');

  for (let i = 0; i < timeline.length; i++) {
    const block = timeline[i];

    lines.push(`### [${i + 1}] ${describeBlock(block)}`);
    lines.push('');

    if (block.state) {
      lines.push(`- URL: ${block.state.url}`);
      lines.push(`- 标题: ${block.state.title}`);
      lines.push('');
    }

    if (block.action) {
      const a = block.action;
      lines.push(`- 操作类型: ${a.type}`);
      lines.push(`- 目标元素: \`${a.tag}${a.id ? '#' + a.id : ''}\`${a.target_element ? ' — ' + a.target_element : ''}`);
      if (a.aria_label) lines.push(`- aria-label: ${a.aria_label}`);
      lines.push('');
    }

    if (block.triggered_network && block.triggered_network.length > 0) {
      lines.push(`**触发的网络请求 (${block.triggered_network.length} 个):**`);
      lines.push('');
      for (const net of block.triggered_network) {
        referencedReqIds.add(net.req_id);
        pushNetworkEntry(lines, net, requests, responses);
      }
    }

    if (block.post_action_a11y_tree_summary) {
      lines.push('<details>');
      lines.push('<summary>操作后页面状态 (a11y tree)</summary>');
      lines.push('');
      lines.push('```');
      lines.push(block.post_action_a11y_tree_summary);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Orphan requests not referenced by any timeline block
  const orphanReqIds: string[] = [];
  for (const key of Object.keys(requests)) {
    const reqId = key.replace(/_body\.json$/, '');
    if (!referencedReqIds.has(reqId)) {
      orphanReqIds.push(reqId);
    }
  }

  if (orphanReqIds.length > 0) {
    lines.push('## 其他网络请求（未关联到操作时间线）');
    lines.push('');
    for (const reqId of orphanReqIds) {
      const reqData = requests[`${reqId}_body.json`];
      const resData = responses[`${reqId}_res.json`];
      if (reqData) {
        const status = resData?.status ?? '?';
        const sizeHint = resData?.body != null
          ? ` (${fmtBytes(Buffer.byteLength(typeof resData.body === 'string' ? resData.body : JSON.stringify(resData.body), 'utf-8'))})`
          : '';
        lines.push(`- **${reqData.method} ${reqData.url}** → ${status}${sizeHint}`);
      }
    }
    lines.push('');
  }

  writeFileSync(join(sessionDir, '_context.md'), lines.join('\n'), 'utf-8');
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
