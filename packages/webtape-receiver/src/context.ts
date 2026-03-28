import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import type {
  WebTapePayload,
  ContextBlock,
  NetworkSummary,
  RequestEntry,
  ResponseEntry,
} from './types.js';
import {
  isNoiseHeader,
  SENSITIVE_HEADER_RULES,
  HEADER_VALUE_MAX_LENGTH,
  BODY_FULL_LIMIT,
  BODY_OVERSIZE_HINT_LT_LARGE,
  BODY_OVERSIZE_HINT_LT_HUGE,
  isAllowedProtocol,
  STRIP_FIRST_CLICK,
} from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates', 'context.md.ejs');

let cachedTemplate: string | null = null;

function loadTemplate(): string {
  if (!cachedTemplate) {
    cachedTemplate = readFileSync(TEMPLATE_PATH, 'utf-8');
  }
  return cachedTemplate;
}

function renderHeaders(
  headers: Record<string, string> | null | undefined,
  role: 'request' | 'response',
): string | null {
  if (!headers) return null;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (isNoiseHeader(key, role)) continue;
    const lower = key.toLowerCase();
    const sensitiveRule = SENSITIVE_HEADER_RULES[lower];
    if (sensitiveRule === 'cookie_names') {
      const names = value.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
      lines.push(`${key}: [${names.length} cookies: ${names.join(', ')}]`);
    } else if (sensitiveRule === 'presence_only') {
      lines.push(`${key}: [${lower} present]`);
    } else {
      lines.push(`${key}: ${value.length > HEADER_VALUE_MAX_LENGTH ? value.slice(0, HEADER_VALUE_MAX_LENGTH) + '…' : value}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function bodyOversizeHint(byteSize: number, role: 'request' | 'response'): string {
  const noun = role === 'request' ? '请求' : '响应';
  if (byteSize < BODY_OVERSIZE_HINT_LT_LARGE) {
    return `请查看原始${noun}记录`;
  }
  if (byteSize < BODY_OVERSIZE_HINT_LT_HUGE) {
    return `${noun}体较大，请小心查看原始记录分析`;
  }
  return `${noun}体过大，疑似包含大文件 base64 等情况，请审慎阅读`;
}

type RenderBodyResult =
  | { mode: 'full'; text: string; lang: string; byteSize: number }
  | { mode: 'oversize'; byteSize: number; hint: string };

function renderBody(body: unknown): RenderBodyResult | null {
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
    return { mode: 'full', text, lang, byteSize };
  }
  return { mode: 'oversize', byteSize, hint: bodyOversizeHint(byteSize, 'response') };
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getContentType(headers: Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') return value.split(';')[0].trim();
  }
  return null;
}

/**
 * Render request body info for the network entry summary.
 * - 不超过 BODY_FULL_LIMIT：完整展示（JSON 或纯文本）
 * - 超过阈值：仅类型与大小 + 按体积分级的提示（不写入正文）
 */
function renderRequestBody(body: unknown, headers: Record<string, string> | null | undefined): string[] | null {
  if (body == null) return null;
  if (typeof body === 'string' && body.length === 0) return null;

  const lines: string[] = [];
  const contentType = getContentType(headers);

  let raw: string;
  let isJson = false;

  if (typeof body === 'string') {
    raw = body;
    if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
      try {
        raw = JSON.stringify(JSON.parse(raw), null, 2);
        isJson = true;
      } catch { /* not JSON */ }
    }
  } else {
    raw = JSON.stringify(body, null, 2);
    isJson = true;
  }

  const byteSize = Buffer.byteLength(raw, 'utf-8');
  const typePart = contentType ?? (isJson ? 'application/json' : 'text/plain');
  const meta = `${typePart}, ${fmtBytes(byteSize)}`;

  if (raw.length <= BODY_FULL_LIMIT) {
    lines.push(`入参 (${meta}):`);
    lines.push('```' + (isJson ? 'json' : ''));
    lines.push(raw);
    lines.push('```');
  } else {
    lines.push(`入参: ${meta}`);
    lines.push(bodyOversizeHint(byteSize, 'request'));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Template helpers (passed to EJS as locals)
// ---------------------------------------------------------------------------

function describeBlock(block: ContextBlock): string {
  if (block.state) {
    const label = block.state.title || block.state.url;
    if (block.state.type === 'URL_CHANGE') {
      return `URL 变更: ${label}`;
    }
    return `初始页面: ${label}`;
  }
  if (block.action) {
    const tag = block.action.tag || '';
    const label = block.action.aria_label || block.action.id || block.action.target_element || '';
    return `用户操作: ${block.action.type} ${tag}${label ? ' "' + label + '"' : ''}`;
  }
  return `上下文 ${block.context_id}`;
}

/**
 * Filter and sort timeline blocks.
 * 1. (STRIP_FIRST_CLICK) Remove the first block if it's a CLICK action (often a mis-capture during recording start).
 * 2. Ensure blocks are sorted by timestamp.
 * 3. Filter out network requests with disallowed protocols (http, ws).
 */
function processTimeline(timeline: ContextBlock[]): ContextBlock[] {
  if (timeline.length === 0) return [];

  const sorted = [...timeline].sort((a, b) => a.timestamp - b.timestamp);

  let result = sorted;
  if (STRIP_FIRST_CLICK && sorted[0].action?.type === 'CLICK') {
    result = sorted.slice(1);
  }

  return result.map((block) => ({
    ...block,
    triggered_network: block.triggered_network
      ? block.triggered_network.filter((net) => isAllowedProtocol(net.url))
      : block.triggered_network,
  }));
}

/**
 * Render a single network request entry as a markdown block.
 * Kept as a helper so the EJS template stays focused on document structure.
 */
function makeNetworkEntryRenderer(
  requests: Record<string, RequestEntry>,
  responses: Record<string, ResponseEntry>,
) {
  return (net: NetworkSummary): string => {
    const lines: string[] = [];
    const reqKey = net.detail_path.request.replace(/^requests\//, '');
    const resKey = net.detail_path.response.replace(/^responses\//, '');
    const reqData =
      requests[reqKey] ??
      requests[`${net.req_id}.json`] ??
      requests[`${net.req_id}_body.json`];
    const resData =
      responses[resKey] ??
      responses[`${net.req_id.replace(/^req_/, 'res_')}.json`] ??
      responses[`${net.req_id}_res.json`];

    const sizeHint = net.response_body_bytes != null ? ` (${fmtBytes(net.response_body_bytes)})` : '';
    lines.push(`#### [${net.req_id}] ${net.method} ${net.url} → ${net.status ?? '?'}${sizeHint}`);
    lines.push('');

    if (reqData) {
      const hdr = renderHeaders(reqData.headers, 'request');
      if (hdr) {
        lines.push('请求头:');
        lines.push('```');
        lines.push(hdr);
        lines.push('```');
      }
      const reqBody = renderRequestBody(reqData.body, reqData.headers);
      if (reqBody) lines.push(...reqBody);
    }

    if (resData) {
      const body = renderBody(resData.body);
      if (body) {
        if (body.mode === 'full') {
          lines.push('响应体:');
          lines.push('```' + body.lang);
          lines.push(body.text);
          lines.push('```');
        } else {
          lines.push(`响应体 (${fmtBytes(body.byteSize)}):`);
          lines.push('');
          lines.push(body.hint);
        }
      }
    }

    return lines.join('\n');
  };
}

interface OrphanRequest {
  id: string;
  method: string;
  url: string;
  status: string | number;
  sizeHint: string;
}

function collectOrphanRequests(payload: WebTapePayload, processedTimeline: ContextBlock[]): OrphanRequest[] {
  const referenced = new Set<string>();
  for (const block of processedTimeline) {
    if (block.triggered_network) {
      for (const net of block.triggered_network) referenced.add(net.req_id);
    }
  }

  const orphans: OrphanRequest[] = [];
  for (const key of Object.keys(payload.content.requests)) {
    const reqId = key.endsWith('_body.json')
      ? key.slice(0, -'_body.json'.length)
      : key.slice(0, -'.json'.length);
    if (referenced.has(reqId)) continue;
    const reqData = payload.content.requests[key];
    const resStem = reqId.replace(/^req_/, 'res_');
    const resData =
      payload.content.responses[`${resStem}.json`] ??
      payload.content.responses[`${reqId}_res.json`];
    if (!reqData || !isAllowedProtocol(reqData.url)) continue;

    let sizeHint = '';
    if (resData?.body != null) {
      const raw = typeof resData.body === 'string' ? resData.body : JSON.stringify(resData.body);
      sizeHint = ` (${fmtBytes(Buffer.byteLength(raw, 'utf-8'))})`;
    }
    orphans.push({ id: reqId, method: reqData.method, url: reqData.url, status: resData?.status ?? '?', sizeHint });
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractSiteUrl(payload: WebTapePayload): string {
  for (const block of payload.content['index.json']) {
    if (block.state?.url) return block.state.url;
  }
  return '';
}

export function renderAnalysisContext(payload: WebTapePayload, siteUrl: string): string {
  const { requests, responses, snapshots = {} } = payload.content;
  const timeline = processTimeline(payload.content['index.json']);

  return ejs.render(loadTemplate(), {
    meta: payload.meta,
    siteUrl,
    timeline,
    snapshots,
    requestCount: Object.keys(requests).length,
    orphanRequests: collectOrphanRequests(payload, timeline),
    describeBlock,
    renderNetworkEntry: makeNetworkEntryRenderer(requests, responses),
  });
}
