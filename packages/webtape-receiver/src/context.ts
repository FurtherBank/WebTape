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

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates', 'context.md.ejs');

let cachedTemplate: string | null = null;

function loadTemplate(): string {
  if (!cachedTemplate) {
    cachedTemplate = readFileSync(TEMPLATE_PATH, 'utf-8');
  }
  return cachedTemplate;
}

// ---------------------------------------------------------------------------
// Header / body formatting
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
  return {
    text: text.slice(0, BODY_PREVIEW_LIMIT) + '\n…(truncated)',
    lang,
    byteSize,
    truncated: true,
  };
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
 * - JSON + small: show content-type, size, and inline JSON
 * - Other / large: show content-type and size only
 * - No body: return null (caller skips)
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

  if (isJson && raw.length <= BODY_FULL_LIMIT) {
    lines.push(`入参 (${meta}):`);
    lines.push('```json');
    lines.push(raw);
    lines.push('```');
  } else {
    lines.push(`入参: ${meta}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Template helpers (passed to EJS as locals)
// ---------------------------------------------------------------------------

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
    const reqData = requests[`${net.req_id}_body.json`];
    const resData = responses[`${net.req_id}_res.json`];

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
      const reqBody = renderRequestBody(reqData.body, reqData.headers);
      if (reqBody) lines.push(...reqBody);
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
        const note = body.truncated ? ` (${fmtBytes(body.byteSize)}, 已截断)` : '';
        lines.push(`响应体${note}:`);
        lines.push('```' + body.lang);
        lines.push(body.text);
        lines.push('```');
      }
    }

    return lines.join('\n');
  };
}

interface OrphanRequest {
  method: string;
  url: string;
  status: string | number;
  sizeHint: string;
}

function collectOrphanRequests(payload: WebTapePayload): OrphanRequest[] {
  const referenced = new Set<string>();
  for (const block of payload.content['index.json']) {
    if (block.triggered_network) {
      for (const net of block.triggered_network) referenced.add(net.req_id);
    }
  }

  const orphans: OrphanRequest[] = [];
  for (const key of Object.keys(payload.content.requests)) {
    const reqId = key.replace(/_body\.json$/, '');
    if (referenced.has(reqId)) continue;
    const reqData = payload.content.requests[key];
    const resData = payload.content.responses[`${reqId}_res.json`];
    if (!reqData) continue;

    let sizeHint = '';
    if (resData?.body != null) {
      const raw = typeof resData.body === 'string' ? resData.body : JSON.stringify(resData.body);
      sizeHint = ` (${fmtBytes(Buffer.byteLength(raw, 'utf-8'))})`;
    }
    orphans.push({ method: reqData.method, url: reqData.url, status: resData?.status ?? '?', sizeHint });
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
  const { requests, responses } = payload.content;

  return ejs.render(loadTemplate(), {
    meta: payload.meta,
    siteUrl,
    timeline: payload.content['index.json'],
    requestCount: Object.keys(requests).length,
    orphanRequests: collectOrphanRequests(payload),
    describeBlock,
    renderNetworkEntry: makeNetworkEntryRenderer(requests, responses),
  });
}
