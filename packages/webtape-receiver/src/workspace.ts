import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface WorkspacePaths {
  root: string;
  recordings: string;
  analyses: string;
}

/**
 * Resolve the WebTape workspace root. Priority:
 * 1. Explicit --workspace CLI flag
 * 2. ~/Desktop/WebTape (macOS default)
 */
export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit) return explicit;
  return join(homedir(), 'Desktop', 'WebTape');
}

/**
 * Ensure the workspace directory tree exists and return the resolved paths.
 */
export function ensureWorkspace(root: string): WorkspacePaths {
  const recordings = join(root, 'recordings');
  const analyses = join(root, 'analyses');

  for (const dir of [root, recordings, analyses]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return { root, recordings, analyses };
}
