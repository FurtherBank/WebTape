/**
 * webtape install — registers the Native Messaging host with Chrome/Edge/Brave
 * and opens the Chrome Web Store page for the extension.
 *
 * The host manifest is written to the OS-specific NativeMessagingHosts directory.
 * After installation, Chrome will spawn the webtape binary on-demand whenever
 * the extension calls chrome.runtime.connectNative('com.webtape.receiver').
 */

import {
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync, execFile } from 'node:child_process';
import chalk from 'chalk';

export const HOST_NAME = 'com.webtape.receiver';

/** Chrome Web Store extension URL — update when published */
export const CWS_URL =
  'https://chrome.google.com/webstore/detail/webtape/pending';

/**
 * Paths where Chrome (and Chromium-family browsers) look for NativeMessagingHosts
 * on each OS.
 */
function getNativeMessagingDirs(): { label: string; path: string }[] {
  const os = platform();
  const home = homedir();

  if (os === 'darwin') {
    return [
      {
        label: 'Chrome',
        path: join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      },
      {
        label: 'Chromium',
        path: join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
      },
      {
        label: 'Brave',
        path: join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      },
      {
        label: 'Edge',
        path: join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'),
      },
    ];
  }

  if (os === 'linux') {
    return [
      {
        label: 'Chrome',
        path: join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      },
      {
        label: 'Chromium',
        path: join(home, '.config', 'chromium', 'NativeMessagingHosts'),
      },
      {
        label: 'Brave',
        path: join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      },
      {
        label: 'Edge',
        path: join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
      },
    ];
  }

  if (os === 'win32') {
    // On Windows, registration goes to the registry; we write a helper manifest
    // to APPDATA and then set the registry key.
    return [
      {
        label: 'Windows (APPDATA)',
        path: join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'WebTape', 'NativeMessagingHosts'),
      },
    ];
  }

  return [];
}

/**
 * Resolve the absolute path to the webtape executable (i.e. this process).
 */
function resolveExecutablePath(): string {
  // When installed via npm -g, `process.execPath` is node and argv[1] is the script.
  // We want the wrapper script (the `bin` entry), not node itself.
  // The npm bin wrapper lives adjacent to node or in npm's bin dir.
  try {
    const result = execSync('which webtape', { encoding: 'utf-8' }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // fall through
  }

  // Fallback: use node + the current script as the host command
  return process.argv[1];
}

/**
 * Build the Native Messaging host manifest JSON.
 */
function buildManifest(executablePath: string, extensionId: string): object {
  const os = platform();

  if (os === 'win32') {
    return {
      name: HOST_NAME,
      description: 'WebTape Native Messaging Host',
      path: executablePath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    };
  }

  return {
    name: HOST_NAME,
    description: 'WebTape Native Messaging Host',
    path: executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function writeWindowsRegistry(manifestPath: string): void {
  try {
    execSync(
      `reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /ve /d "${manifestPath}" /f`,
      { stdio: 'ignore' },
    );
    console.log(chalk.green('    ✓ Chrome (Registry)'));
  } catch {
    console.log(chalk.yellow('    ⚠ 无法写入 Chrome 注册表，请手动添加'));
  }
  try {
    execSync(
      `reg add "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}" /ve /d "${manifestPath}" /f`,
      { stdio: 'ignore' },
    );
    console.log(chalk.green('    ✓ Edge (Registry)'));
  } catch {
    // Edge is optional
  }
}

function openUrl(url: string): void {
  const os = platform();
  try {
    if (os === 'darwin') execFile('open', [url]);
    else if (os === 'win32') execFile('cmd', ['/c', 'start', '', url]);
    else execFile('xdg-open', [url]);
  } catch {
    // Best effort
  }
}

/**
 * Read the extension ID from the built manifest file (if available in the
 * package root — used for development). In production the user provides it
 * or it defaults to the published ID.
 */
function readExtensionIdFromManifest(): string | null {
  // Walk up from __dirname to find the root manifest.json
  let dir = new URL('..', import.meta.url).pathname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'manifest.json');
    if (existsSync(candidate)) {
      try {
        const json = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (json.key) {
          // CRX key → ID derivation is non-trivial; skip for now
          return null;
        }
      } catch {
        // ignore
      }
    }
    dir = join(dir, '..');
  }
  return null;
}

export interface InstallOptions {
  extensionId?: string;
  openStore?: boolean;
}

export async function runInstall(opts: InstallOptions = {}): Promise<void> {
  console.log('');
  console.log(chalk.bold.cyan('  🔧 WebTape — 安装 Native Messaging Host'));
  console.log(chalk.gray('  ─────────────────────────────────────────'));
  console.log('');

  const extensionId = opts.extensionId ?? readExtensionIdFromManifest() ?? 'PENDING_EXTENSION_ID';
  const executablePath = resolveExecutablePath();
  const manifest = buildManifest(executablePath, extensionId);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const os = platform();

  console.log(`  ${chalk.green('可执行文件')}  ${executablePath}`);
  console.log(`  ${chalk.green('扩展 ID')}    ${extensionId}`);
  console.log('');

  const dirs = getNativeMessagingDirs();

  if (os === 'win32') {
    // On Windows: write a single manifest file and register in the registry
    const winDir = dirs[0].path;
    mkdirSync(winDir, { recursive: true });
    const manifestPath = join(winDir, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, manifestJson, 'utf-8');
    console.log(chalk.green(`  ✓ 已写入 manifest → ${manifestPath}`));
    console.log('');
    console.log('  正在写入 Windows 注册表…');
    writeWindowsRegistry(manifestPath);
  } else {
    console.log('  正在写入 NativeMessagingHosts manifest…');
    console.log('');
    for (const dir of dirs) {
      try {
        mkdirSync(dir.path, { recursive: true });
        const manifestPath = join(dir.path, `${HOST_NAME}.json`);
        writeFileSync(manifestPath, manifestJson, 'utf-8');
        console.log(chalk.green(`    ✓ ${dir.label}: ${manifestPath}`));
      } catch (err) {
        console.log(chalk.gray(`    - ${dir.label}: 跳过 (${(err as Error).message})`));
      }
    }

    // Ensure the executable is executable
    try {
      chmodSync(executablePath, 0o755);
    } catch {
      // ignore
    }
  }

  console.log('');
  console.log(chalk.green('  ✅ Native Messaging Host 注册完成'));
  console.log('');

  if (opts.openStore !== false) {
    console.log(chalk.cyan('  正在打开 Chrome 插件安装页…'));
    openUrl(CWS_URL);
    console.log(chalk.gray('  请在浏览器中点击"添加到 Chrome"完成插件安装。'));
    console.log('');
    console.log(chalk.gray('  提示：如果浏览器没有自动打开，请手动访问:'));
    console.log(chalk.cyan(`  ${CWS_URL}`));
  }

  console.log('');
  console.log(chalk.bold('  安装完成！'));
  console.log(chalk.gray('  录制时直接点击插件图标，无需任何额外操作。'));
  console.log('');
}
