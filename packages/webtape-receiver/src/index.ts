#!/usr/bin/env node

import { join } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolveWorkspaceRoot, ensureWorkspace } from './workspace.js';
import { createWebhookServer } from './server.js';
import { listRecordings, listUnanalyzedRecordings, parseSessionName, formatTime } from './storage.js';
import { analyzeRecording, type AnalyzerBackend, type AnalyzeResult } from './analyzer.js';
import { loadConfig, promptAiBackend, runConfigWizard } from './config.js';

const VERSION = '1.4.3';

const program = new Command();

program
  .name('webtape-receiver')
  .description('接收 WebTape 插件的 webhook 数据，保存录制内容并通过 AI 分析业务接口链路')
  .version(VERSION);

/**
 * Log analysis result — success or failure hint.
 */
function logAnalyzeResult(result: AnalyzeResult): void {
  if (result.success) {
    const { domain, time } = parseSessionName(result.sessionName);
    const formattedTime = formatTime(time);
    const durationText = result.duration ? chalk.gray(` (耗时 ${(result.duration / 1000).toFixed(1)}s)`) : '';
    console.log(chalk.green(`  ✅ 已将 ${formattedTime} 录制的 ${domain} 站点 api 分析记录保存到了 ${result.reportPath}${durationText}`));
  } else {
    console.log(chalk.yellow(`  ⚠️ 未检测到分析报告: ${result.reportPath}`));
    console.log(chalk.gray('  你可以稍后使用 webtape-receiver retry 命令重新分析所有未完成的记录。'));
  }
}

// ─── serve ───────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('启动 webhook 接收服务器')
  .option('-p, --port <number>', '监听端口', '5643')
  .option('-w, --workspace <path>', '工作区路径（默认 ~/Desktop/WebTape）')
  .option('--no-auto-analyze', '接收数据后不自动运行 AI 分析')
  .option('--backend <name>', 'AI 分析后端（cursor / claude）', '')
  .option('--model <name>', 'AI 模型名称（例如 kimi-k2.5）')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
    const workspace = ensureWorkspace(workspaceRoot, VERSION);

    // Resolve AI backend: CLI flag > saved config > interactive prompt
    let backend: AnalyzerBackend;
    const config = loadConfig();
    if (opts.backend) {
      backend = opts.backend as AnalyzerBackend;
    } else if (config.aiBackend) {
      backend = config.aiBackend;
    } else {
      backend = await promptAiBackend();
    }

    console.log('');
    console.log(chalk.bold.cyan('  🎬 WebTape Receiver') + chalk.gray(` v${VERSION}`));
    console.log(chalk.gray('  ─────────────────────────────────'));
    console.log(`  ${chalk.green('工作区')}  ${workspace.root}`);
    console.log(`  ${chalk.green('端口')}    ${port}`);
    console.log(`  ${chalk.green('自动分析')} ${opts.autoAnalyze ? chalk.yellow('开启') : chalk.gray('关闭')}`);
    console.log(`  ${chalk.green('AI 后端')} ${backend}`);
    if (opts.model) {
      console.log(`  ${chalk.green('AI 模型')} ${opts.model}`);
    }
    console.log('');

    const spinner = ora('正在启动服务器…').start();

    const srv = createWebhookServer({
      port,
      workspace,
      autoAnalyze: opts.autoAnalyze,
      analyzerBackend: backend,
      analyzerModel: opts.model,
      onReceive(sessionDir, payload) {
        const actions = payload.content['index.json'].filter((b) => b.action).length;
        const requests = Object.keys(payload.content.requests).length;
        console.log('');
        console.log(chalk.green('  ✓ 收到录制数据'));
        console.log(`    ${chalk.gray('会话')}    ${sessionDir}`);
        console.log(`    ${chalk.gray('操作数')}  ${actions}`);
        console.log(`    ${chalk.gray('请求数')}  ${requests}`);
        if (opts.autoAnalyze) {
          console.log('');
          console.log(chalk.cyan('  ⏳ 正在启动 AI 分析…') + chalk.gray(' (预估 1-2min，请稍候)'));
        }
      },
      onAnalyzeLog(line) {
        if (opts.autoAnalyze) {
          process.stdout.write(chalk.gray(`    ${line.length > 80 ? line.slice(0, 77) + '...' : line}\r`));
        }
      },
      onAnalyzeDone(result) {
        if (opts.autoAnalyze) {
          process.stdout.write(' '.repeat(process.stdout.columns || 80) + '\r');
        }
        console.log('');
        logAnalyzeResult(result);
      },
      onError(err) {
        console.error('');
        console.error(chalk.red('  ✗ 错误:'), err.message);
      },
    });

    try {
      await srv.start();
      spinner.succeed(`服务器已启动，监听端口 ${chalk.bold(String(port))}`);
      console.log('');
      console.log(chalk.gray('  在 WebTape 插件中将 webhook URL 设置为:'));
      console.log(chalk.cyan(`  http://localhost:${port}/webhook`));
      console.log('');
      console.log(chalk.gray('  按 Ctrl+C 停止服务器'));
      console.log('');
    } catch (err) {
      spinner.fail('服务器启动失败');
      console.error(err);
      process.exit(1);
    }

    const shutdown = async () => {
      console.log('');
      const stopSpinner = ora('正在关闭服务器…').start();
      await srv.stop();
      stopSpinner.succeed('服务器已关闭');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// ─── list ────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('列出所有录制会话')
  .option('-w, --workspace <path>', '工作区路径')
  .action((opts) => {
    const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
    const workspace = ensureWorkspace(workspaceRoot, VERSION);
    const sessions = listRecordings(workspace);

    if (sessions.length === 0) {
      console.log(chalk.gray('暂无录制会话。'));
      return;
    }

    console.log('');
    console.log(chalk.bold(`录制会话（共 ${sessions.length} 个）:`));
    console.log('');
    for (const s of sessions) {
      console.log(`  ${chalk.cyan('●')} ${s}`);
    }
    console.log('');
  });

// ─── analyze ─────────────────────────────────────────────────────────────────

program
  .command('analyze <session>')
  .description('对指定的录制会话运行 AI 分析')
  .option('-w, --workspace <path>', '工作区路径')
  .option('--backend <name>', 'AI 分析后端（cursor / claude）', '')
  .option('--model <name>', 'AI 模型名称（例如 kimi-k2.5）')
  .action(async (session, opts) => {
    const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
    const workspace = ensureWorkspace(workspaceRoot, VERSION);
    const sessionDir = join(workspace.recordings, session);

    // Resolve AI backend: CLI flag > saved config > default cursor
    let backend: AnalyzerBackend;
    const config = loadConfig();
    if (opts.backend) {
      backend = opts.backend as AnalyzerBackend;
    } else if (config.aiBackend) {
      backend = config.aiBackend;
    } else {
      backend = 'cursor';
    }

    const spinner = ora(`正在通过 ${backend} 分析会话 ${session}…`).start();
    spinner.text = `正在通过 ${backend} 分析会话 ${session}… ${chalk.gray('(预估 1-2min，请稍候)')}`;
    try {
      const result = await analyzeRecording({
        backend,
        workspace,
        sessionDir,
        model: opts.model,
        onLog: (line) => {
          spinner.text = `正在通过 ${backend} 分析会话 ${session}… ${chalk.gray('(预估 1-2min，请稍候)')}\n    ${chalk.gray(line.length > 80 ? line.slice(0, 77) + '...' : line)}`;
        },
      });
      spinner.stop();
      logAnalyzeResult(result);
    } catch (err) {
      spinner.fail('分析失败');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─── retry ───────────────────────────────────────────────────────────────────

program
  .command('retry')
  .description('重新分析所有未生成报告的录制会话')
  .option('-w, --workspace <path>', '工作区路径')
  .option('--backend <name>', 'AI 分析后端（cursor / claude）', '')
  .option('--model <name>', 'AI 模型名称（例如 kimi-k2.5）')
  .action(async (opts) => {
    const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
    const workspace = ensureWorkspace(workspaceRoot, VERSION);
    const unanalyzed = listUnanalyzedRecordings(workspace);

    if (unanalyzed.length === 0) {
      console.log(chalk.green('  ✅ 所有录制会话均已完成分析。'));
      return;
    }

    // Resolve AI backend: CLI flag > saved config > default cursor
    let backend: AnalyzerBackend;
    const config = loadConfig();
    if (opts.backend) {
      backend = opts.backend as AnalyzerBackend;
    } else if (config.aiBackend) {
      backend = config.aiBackend;
    } else {
      backend = 'cursor';
    }

    console.log('');
    console.log(chalk.bold(`待分析会话（共 ${unanalyzed.length} 个）:`));
    for (const s of unanalyzed) {
      console.log(`  ${chalk.cyan('●')} ${s}`);
    }
    console.log('');

    for (const session of unanalyzed) {
      const sessionDir = join(workspace.recordings, session);
      const spinner = ora(`正在通过 ${backend} 分析会话 ${session}…`).start();
      spinner.text = `正在通过 ${backend} 分析会话 ${session}… ${chalk.gray('(预估 1-2min，请稍候)')}`;
      try {
        const result = await analyzeRecording({
          backend,
          workspace,
          sessionDir,
          model: opts.model,
          onLog: (line) => {
            spinner.text = `正在通过 ${backend} 分析会话 ${session}… ${chalk.gray('(预估 1-2min，请稍候)')}\n    ${chalk.gray(line.length > 80 ? line.slice(0, 77) + '...' : line)}`;
          },
        });
        spinner.stop();
        logAnalyzeResult(result);
      } catch (err) {
        spinner.fail(`分析 ${session} 失败`);
        console.error(err instanceof Error ? err.message : err);
      }
    }
  });

// ─── config ──────────────────────────────────────────────────────────────────

const configCmd = program
  .command('config')
  .description('交互式配置向导')
  .action(async () => {
    await runConfigWizard();
  });

configCmd
  .command('show')
  .description('显示当前配置')
  .action(() => {
    const config = loadConfig();
    console.log('');
    console.log(chalk.bold('当前配置:'));
    console.log('');
    if (Object.keys(config).length === 0) {
      console.log(chalk.gray('  （尚无配置，运行 webtape-receiver config 进行设置）'));
    } else {
      if (config.aiBackend) {
        console.log(`  ${chalk.green('AI 后端')}  ${config.aiBackend}`);
      }
    }
    console.log('');
  });

program.parse();
