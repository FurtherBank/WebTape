## Cursor Cloud specific instructions

### Project overview

WebTape is a Chrome browser extension + **webtape-receiver** CLI (Node.js/TypeScript). See `README.md` for details.

| Component | Path | Description |
|---|---|---|
| Chrome Extension | `/` (root) | Plain JS, Manifest V3 extension |
| webtape-receiver | `packages/webtape-receiver/` | TypeScript CLI: HTTP webhook server + AI analysis |

### Running services

- **webtape-receiver** (the only runnable service in Cloud): build first, then start with `--backend cursor` to skip interactive prompt.
  ```
  cd packages/webtape-receiver && npm run build && node dist/index.js serve --backend cursor
  ```
- The Chrome extension itself requires a real Chrome browser with `chrome://extensions` → Load Unpacked; it cannot be tested headlessly due to `chrome.debugger` CDP dependency.

### Key caveats

- `npm run dev` (tsx) in `packages/webtape-receiver` fails because `workspace.zip` is generated only during `npm run build` (in `dist/`), but tsx resolves `__dirname` to `src/`. Always build before running.
- No test framework is configured; there are no automated tests in the repository.
- No ESLint is configured. TypeScript type checking (`npx tsc --noEmit` in `packages/webtape-receiver/`) is the closest lint check available.
- `packages/webtape-receiver/workspace/AGENTS.md` is an **auto-generated template** shipped inside `workspace.zip` for end-user AI analysis workspaces — it is not a project-level AGENTS.md.

### Standard commands

See `package.json` scripts at root and `packages/webtape-receiver/package.json`:

- **Root**: `npm install` (also runs postinstall to copy `jszip.min.js`), `npm run build` (zip extension)
- **Receiver**: `npm install`, `npm run build` (tsc + pack-workspace), `npx tsc --noEmit` (type check)
