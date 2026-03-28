/**
 * Webhook payload sent by the WebTape Chrome extension (background.js).
 */
export interface WebTapePayload {
  meta: {
    timestamp: string;
    epoch: number;
    version: string;
    source: string;
    hostname?: string;
  };
  content: {
    'index.json': ContextBlock[];
    /** context_id → a11y tree text for each post-action snapshot */
    snapshots?: Record<string, string>;
    requests: Record<string, RequestEntry>;
    responses: Record<string, ResponseEntry>;
  };
}

/**
 * ContextBlock as written to disk: timestamp is converted from unix ms to a
 * local-timezone ISO string (e.g. "2026-03-20T14:30:45.123+08:00").
 */
export type SavedContextBlock = Omit<ContextBlock, 'timestamp'> & {
  timestamp: string;
};

/**
 * Shape of the index.json file written to disk for each recording session.
 * meta.json is not written separately; only version (unique to meta) is kept here.
 * All other meta fields (epoch, timestamp, source, hostname) are derivable from timeline.
 */
export interface SavedIndexFile {
  meta: {
    version: string;
  };
  timeline: SavedContextBlock[];
}

export interface ContextBlock {
  context_id: string;
  timestamp: number;
  /** Asia/Shanghai (+08:00) instant from the extension, e.g. 2026-03-28T15:30:45.123+08:00 */
  timestamp_cst?: string;
  state?: {
    type: string;
    url: string;
    title: string;
    fav_icon_url: string;
    a11y_tree_summary: string;
  };
  action?: {
    type: string;
    target_element: string;
    tag: string;
    id: string;
    aria_label: string;
  };
  triggered_network?: NetworkSummary[] | null;
  /** ID pointing to the post-action a11y snapshot file: snapshots/snapshot_${snapshot_id}.md */
  snapshot_id?: string | null;
}

export interface NetworkSummary {
  req_id: string;
  method: string;
  url: string;
  status: number | null;
  type: 'http' | 'sse' | 'websocket';
  detail_path: {
    request: string;
    response: string;
  };
  response_body_bytes?: number;
}

export interface RequestEntry {
  req_id: string;
  /** Asia/Shanghai (+08:00), request start wall time */
  timestamp_cst?: string;
  type: 'http' | 'sse' | 'websocket';
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ResponseEntry {
  req_id: string;
  /** Asia/Shanghai (+08:00), response completion wall time when available */
  timestamp_cst?: string;
  type: 'http' | 'sse' | 'websocket';
  status: number | null;
  headers: Record<string, string> | null;
  mime_type?: string;
  body: string | object | null;
}
