# WebTape — Web Action Recorder

A Chrome Extension (Manifest V3) that silently records user interactions, network requests, and accessibility-tree snapshots, then exports everything as a structured ZIP file for LLM-powered analysis and code generation.

## Features

- **Direct Record** — attaches debugger immediately, captures the current page state.
- **Refresh & Record** — attaches debugger then reloads the page, capturing the full initialisation flow.
- **Stop & Export** — finalises the session and downloads a tiered ZIP archive.
- **A11y-powered DOM** — uses Chrome's Accessibility Tree instead of raw HTML to minimise token usage.
- **Sliding-window request attribution** — automatically associates network calls with the user action that triggered them.
- **Hierarchical ZIP** — `index.json` (skeleton + A11y summaries) + `requests/` + `responses/` folders.
- **SSE (Server-Sent Events) capture** — captures individual SSE events with timestamps, event names, IDs, and data via CDP `Network.eventSourceMessageReceived`.
- **WebSocket capture** — captures WebSocket handshake, sent/received frames, and connection lifecycle via CDP WebSocket events.

## ZIP Output Structure

```
webtape_<timestamp>.zip
│
├── index.json              # Level 1 – AI-readable timeline skeleton
├── requests/               # Level 2 – full request bodies (by req_id)
│   └── req_0001_<ts>_body.json
└── responses/              # Level 2 – full response bodies (by req_id)
    └── req_0001_<ts>_res.json
```

### Response Format by Type

Each response file includes a `type` field indicating the protocol used:

**HTTP** (`type: "http"`):
```json
{
  "req_id": "req_0001_...",
  "type": "http",
  "status": 200,
  "headers": { ... },
  "mime_type": "application/json",
  "body": "{ \"key\": \"value\" }"
}
```

**SSE** (`type: "sse"`):
```json
{
  "req_id": "req_0002_...",
  "type": "sse",
  "status": 200,
  "headers": { ... },
  "mime_type": "text/event-stream",
  "body": [
    { "timestamp": 1705333845.123, "event": "message", "id": "1", "data": "..." },
    { "timestamp": 1705333845.456, "event": "update", "id": "2", "data": "..." }
  ]
}
```

**WebSocket** (`type: "websocket"`):
```json
{
  "req_id": "req_0003_...",
  "type": "websocket",
  "status": 101,
  "headers": { ... },
  "body": [
    { "timestamp": 1705333845.123, "direction": "sent", "opcode": 1, "data": "..." },
    { "timestamp": 1705333845.456, "direction": "received", "opcode": 1, "data": "..." }
  ]
}
```

## Installation

### From source

1. Clone the repository.
2. Install dependencies (copies `jszip.min.js` into `lib/`):
   ```bash
   npm install
   ```
3. Open Chrome and navigate to `chrome://extensions`.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the repository root.

## Usage

1. Click the WebTape toolbar icon.
2. Navigate to the page you want to record.
3. Click **Direct Record** (or **Refresh & Record** to capture the full page load).
4. Interact with the page normally.
5. Click **Stop & Export** — a ZIP file will be downloaded automatically.

## Architecture

| Module | Location | Responsibility |
|---|---|---|
| UI & Control | `popup.html` / `popup.js` | User controls, state display |
| CDP Sniffer | `background.js` | `chrome.debugger` attach/detach, Network + Accessibility CDP domains |
| Action Capture | `content.js` | DOM event listeners → action messages |
| Aggregation Engine | `background.js` | Sliding-window context matching |
| Export Module | `background.js` | JSZip packaging, `chrome.downloads` trigger |

## Release

To publish a new release, push a version tag to the `main` branch:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the GitHub Actions workflow which builds the extension package and creates a GitHub Release with the `webtape-v1.0.0.zip` artifact.

## File Overview

```
manifest.json      Chrome Extension Manifest V3
background.js      Service worker – CDP, aggregation, export
content.js         Content script – action capture
popup.html         Popup UI markup
popup.js           Popup logic
popup.css          Popup styles
lib/
  jszip.min.js     Bundled JSZip library
icons/
  icon{16,32,48,128}.png  Extension icons
```
