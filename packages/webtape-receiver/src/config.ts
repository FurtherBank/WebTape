import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
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
  } catch (err) {
    console.warn('Failed to parse config file, using defaults:', (err as Error).message);
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

// ---------------------------------------------------------------------------
// Interactive arrow-key selector
// ---------------------------------------------------------------------------

interface SelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Re-render the selector list in-place by moving the cursor up and overwriting. */
function renderSelector<T>(
  title: string,
  options: SelectOption<T>[],
  cursor: number,
  isFirst: boolean,
): void {
  const lineCount = options.length + 2; // blank line + title + options
  if (!isFirst) {
    process.stdout.write(`\x1b[${lineCount}A`); // move up
    process.stdout.write('\x1b[0J');            // clear to end of screen
  }
  process.stdout.write(`\n  ${chalk.bold(title)}\n`);
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const hint = opt.hint ? chalk.gray(`  ${opt.hint}`) : '';
    if (i === cursor) {
      process.stdout.write(`  ${chalk.cyan('❯')} ${chalk.cyan(opt.label)}${hint}\n`);
    } else {
      process.stdout.write(`    ${chalk.dim(opt.label)}${hint}\n`);
    }
  }
}

/**
 * Show an interactive list that the user navigates with arrow keys.
 * Returns the selected value, or null if the user pressed ESC.
 */
export async function selectItem<T>(
  title: string,
  options: SelectOption<T>[],
  initialIndex = 0,
): Promise<T | null> {
  if (!process.stdin.isTTY) {
    // Non-interactive fallback: return first/current option silently
    return options[Math.max(0, Math.min(initialIndex, options.length - 1))].value;
  }

  let cursor = Math.max(0, Math.min(initialIndex, options.length - 1));
  renderSelector(title, options, cursor, true);

  return new Promise<T | null>((resolve) => {
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (key: string) => {
      if (key === '\x1b[A') {
        // Up arrow — previous option
        cursor = (cursor - 1 + options.length) % options.length;
        renderSelector(title, options, cursor, false);
      } else if (key === '\x1b[B') {
        // Down arrow — next option
        cursor = (cursor + 1) % options.length;
        renderSelector(title, options, cursor, false);
      } else if (key === '\r' || key === '\n') {
        // Enter — confirm selection
        cleanup();
        process.stdout.write('\n');
        resolve(options[cursor].value);
      } else if (key === '\x1b') {
        // ESC — abort
        cleanup();
        process.stdout.write('\n');
        resolve(null);
      } else if (key === '\x03') {
        // Ctrl+C
        cleanup();
        process.stdout.write('\n');
        process.exit(0);
      }
    };

    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// Config wizard
// ---------------------------------------------------------------------------

interface ConfigStep<K extends keyof WebtapeConfig> {
  key: K;
  title: string;
  options: SelectOption<WebtapeConfig[K]>[];
}

const CONFIG_STEPS = [
  {
    key: 'aiBackend' as const,
    title: '请选择 AI 分析后端 / Select AI analysis backend',
    options: [
      { label: 'cursor', value: 'cursor' as AnalyzerBackend, hint: 'Cursor Agent  (cursor agent …)' },
      { label: 'claude', value: 'claude' as AnalyzerBackend, hint: 'Claude Code   (claude … --dangerously-skip-permissions)' },
      { label: '不分析', value: 'none'  as AnalyzerBackend, hint: '仅接收并保存录制数据，不自动运行 AI 分析' },
    ],
  },
] satisfies ConfigStep<keyof WebtapeConfig>[];

/**
 * Run the interactive configuration wizard.
 * Steps through each config item in sequence; ESC exits without saving.
 * Returns the saved config, or null if aborted.
 */
export async function runConfigWizard(): Promise<WebtapeConfig | null> {
  const current = loadConfig();
  const result: Partial<WebtapeConfig> = { ...current };

  console.log('');
  console.log(chalk.bold.cyan('  ⚙️  WebTape 配置向导'));
  console.log(chalk.gray('  ↑↓ 选择  Enter 确认  Esc 退出'));
  console.log(chalk.gray('  ─────────────────────────────────'));

  for (const step of CONFIG_STEPS) {
    const currentVal = result[step.key];
    const initialIdx = step.options.findIndex((o) => o.value === currentVal);

    const selected = await selectItem(
      step.title,
      step.options,
      initialIdx >= 0 ? initialIdx : 0,
    );

    if (selected === null) {
      console.log(chalk.gray('  已取消，配置未更改。\n'));
      return null;
    }

    (result as Record<string, unknown>)[step.key] = selected;
  }

  const saved = saveConfig(result);

  console.log(chalk.green('  ✅ 配置已保存:'));
  for (const step of CONFIG_STEPS) {
    const val = saved[step.key];
    if (val !== undefined) {
      console.log(`    ${chalk.green(step.key)}  ${val}`);
    }
  }
  console.log('');

  return saved;
}

/**
 * Prompt for AI backend interactively.
 * Used by the serve command when no backend is configured yet.
 */
export async function promptAiBackend(): Promise<AnalyzerBackend> {
  const result = await runConfigWizard();
  return (result?.aiBackend ?? 'cursor') as AnalyzerBackend;
}
