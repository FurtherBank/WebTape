import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AnalyzerBackend } from './analyzer.js';

const CONFIG_DIR = join(homedir(), '.webtape-receiver');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface WebtapeConfig {
  aiBackend?: AnalyzerBackend;
}

/**
 * Load the persisted configuration, returning an empty object if none exists.
 */
export function loadConfig(): WebtapeConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save the configuration to disk (merges with existing).
 */
export function saveConfig(partial: Partial<WebtapeConfig>): WebtapeConfig {
  const current = loadConfig();
  const merged = { ...current, ...partial };
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * Interactive prompt: ask the user to choose an AI backend.
 * Uses Node.js built-in readline so we don't add any dependencies.
 */
export async function promptAiBackend(): Promise<AnalyzerBackend> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<AnalyzerBackend>((resolve) => {
    console.log('');
    console.log('  请选择 AI 分析后端 / Select AI analysis backend:');
    console.log('');
    console.log('    1) cursor  — Cursor Agent (cursor agent …)');
    console.log('    2) claude  — Claude Code  (claude … --dangerously-skip-permissions)');
    console.log('');

    const ask = () => {
      rl.question('  请输入选项 (1/2): ', (answer) => {
        const trimmed = answer.trim();
        if (trimmed === '1' || trimmed === 'cursor') {
          rl.close();
          resolve('cursor');
        } else if (trimmed === '2' || trimmed === 'claude') {
          rl.close();
          resolve('claude');
        } else {
          console.log('  无效输入，请输入 1 或 2');
          ask();
        }
      });
    };
    ask();
  });
}
