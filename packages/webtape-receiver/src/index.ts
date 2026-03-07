#!/usr/bin/env node

import { relative } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolveWorkspaceRoot, ensureWorkspace } from './workspace.js';
import { createWebhookServer } from './server.js';
import { listRecordings } from './storage.js';
import { analyzeRecording, generatePromptFile } from './analyzer.js';

const VERSION = '1.2.0';

const program = new Command();

program
  .name('webtape-receiver')
  .description('接收 WebTape 插件的 webhook 数据，保存录制内容并通过 AI 分析业务接口链路')
  .version(VERSION);

// ─── serve ───────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('启动 webhook 接收服务器')
  .option('-p, --port <number>', '监听端口', '5643')
  .option('-w, --workspace <path>', '工作区路径（默认 ~/Desktop/WebTape）')
  .option('--no-auto-analyze', '接收数据后不自动运行 AI 分析')
  .option('--backend <name>', 'AI 分析后端（cursor）', 'cursor')
  .option('--model <name>', 'AI 模型名称（例如 kimi-k2.5）')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
    const workspace = ensureWorkspace(workspaceRoot);

    console.log('');
    console.log(chalk.bold.cyan('  🎬 WebTape Receiver'));
    console.log(chalk.gray('  ─────────────────────────────────'));
    console.log(`  ${chalk.green('工作区')}  ${workspace.root}`);
    console.log(`  ${chalk.green('端口')}    ${port}`);
    console.log(`  ${chalk.green('自动分析')} ${opts.autoAnalyze ? chalk.yellow('开启') : chalk.gray('关闭')}`);
    console.log(`  ${chalk.green('AI 后端')} ${opts.backend}`);
    if (opts.model) {
      console.log(`  ${chalk.green('AI 模型')} ${opts.model}`);
    }
    console.log('');

    const spinner = ora('正在启动服务器…').start();

    const srv = createWebhookServer({
      port,
      workspace,
      autoAnalyze: opts.autoAnalyze,
      analyzerBackend: opts.backend,
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
          console.log(chalk.cyan('  ⏳ 正在启动 AI 分析…'));
        }
      },
      onAnalyzeDone(reportPath) {
        const relativePath = relative(workspace.root, reportPath);
        const isInsideWorkspace = !relativePath.startsWith('..');
        console.log('');
        console.log(chalk.green('  ✓ AI 分析完成'));
        if (isInsideWorkspace) {
          console.log(`    ${chalk.gray('产物位置')} ${relativePath}`);
        }
        console.log(`    ${chalk.gray('完整路径')} ${reportPath}`);
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
    const workspace = ensureWorkspace(workspaceRoot);
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
  .option('--backend <name>', 'AI 分析后端（cursor）', 'cursor')
  .option('--model <name>', 'AI 模型名称（例如 kimi-k2.5）')
  .option('--prompt-only', '仅生成提示词文件，不执行分析', false)
  .action(async (session, opts) => {
    const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
    const workspace = ensureWorkspace(workspaceRoot);
    const sessionDir = `${workspace.recordings}/${session}`;

    if (opts.promptOnly) {
      const spinner = ora('正在生成提示词文件…').start();
      try {
        const promptPath = generatePromptFile(sessionDir);
        spinner.succeed('提示词文件已生成');
        console.log(`  ${chalk.gray('路径')} ${promptPath}`);
        console.log('');
        console.log(chalk.gray('  你可以将此文件内容粘贴到 Cursor Chat 中进行分析。'));
      } catch (err) {
        spinner.fail('生成失败');
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
      return;
    }

    const spinner = ora(`正在通过 ${opts.backend} 分析会话 ${session}…`).start();
    try {
      const reportPath = await analyzeRecording({
        backend: opts.backend,
        workspace,
        sessionDir,
        model: opts.model,
      });
      spinner.succeed('分析完成');
      console.log(`  ${chalk.gray('报告')} ${reportPath}`);
    } catch (err) {
      spinner.fail('分析失败');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse();
