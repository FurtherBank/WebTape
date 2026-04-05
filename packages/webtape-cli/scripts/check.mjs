#!/usr/bin/env node
/**
 * WebTape Native Messaging 完整诊断脚本
 * 用法: node scripts/check.mjs   (从 packages/webtape-cli 目录运行)
 *
 * 检测项:
 *  [1] 配置文件（可选）— AI 后端等
 *  [2] Manifest 文件 — 每个浏览器的 host manifest 内容合法性（allowed_origins 须为固定插件 ID）
 *  [3] 可执行文件 — 路径存在 / 可执行 / shebang
 *  [4] 协议测试 — 真实 spawn host → ping → pong，验证通信链路
 */

import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(__dirname, '..', 'dist', 'index.js');
const HOST_NAME = 'com.webtape.receiver';
const CONFIG_DIR = join(homedir(), '.webtape-receiver');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const WRAPPER_SCRIPT = join(CONFIG_DIR, 'host.sh');
/** 与 manifest.json `key` 一致，须与 install 中 WEBTAPE_EXTENSION_ID 保持同步 */
const EXPECTED_EXTENSION_ID = 'jcbbpjhckcknopggkbafcjnnhddjpfhm';

// ── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
};
const ok  = (s) => `${c.green}✓${c.reset} ${s}`;
const err = (s) => `${c.red}✗${c.reset} ${s}`;
const warn = (s) => `${c.yellow}⚠${c.reset} ${s}`;
const indent = (s, n = 4) => s.split('\n').map(l => ' '.repeat(n) + l).join('\n');

let failCount = 0;
function check(cond, okMsg, errMsg) {
  if (cond) {
    console.log(indent(ok(okMsg)));
  } else {
    console.log(indent(err(errMsg)));
    failCount++;
  }
  return cond;
}

// ── 获取各浏览器 Manifest 路径 ───────────────────────────────────────────────
function getManifestPaths() {
  const os = platform();
  const home = homedir();
  if (os === 'darwin') return [
    { label: 'Chrome',   path: join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST_NAME}.json`) },
    { label: 'Chromium', path: join(home, 'Library/Application Support/Chromium/NativeMessagingHosts', `${HOST_NAME}.json`) },
    { label: 'Brave',    path: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts', `${HOST_NAME}.json`) },
    { label: 'Edge',     path: join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', `${HOST_NAME}.json`) },
  ];
  if (os === 'linux') return [
    { label: 'Chrome',   path: join(home, '.config/google-chrome/NativeMessagingHosts', `${HOST_NAME}.json`) },
    { label: 'Chromium', path: join(home, '.config/chromium/NativeMessagingHosts', `${HOST_NAME}.json`) },
  ];
  return [];
}

// ── 协议测试：spawn host → send ping → read pong ────────────────────────────
function buildNativeMsg(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf-8');
  const hdr  = Buffer.allocUnsafe(4);
  hdr.writeUInt32LE(body.length, 0);
  return Buffer.concat([hdr, body]);
}

function readNativeMsg(stream) {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    let body   = Buffer.alloc(0);
    let expected = null;

    const onData = (chunk) => {
      if (expected === null) {
        header = Buffer.concat([header, chunk]);
        if (header.length >= 4) {
          expected = header.readUInt32LE(0);
          body = header.slice(4);
        }
      } else {
        body = Buffer.concat([body, chunk]);
      }
      if (expected !== null && body.length >= expected) {
        stream.removeListener('data', onData);
        stream.removeListener('error', onErr);
        stream.removeListener('end', onEnd);
        try { resolve(JSON.parse(body.slice(0, expected).toString('utf-8'))); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      }
    };
    const onErr = (e) => reject(e);
    const onEnd = () => reject(new Error('stdout closed before pong received'));

    stream.on('data', onData);
    stream.on('error', onErr);
    stream.on('end', onEnd);
  });
}

async function protocolTest(executablePath) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    // For .sh wrapper scripts: spawn via /bin/sh (no PATH dependency, mirrors Chrome's exec)
    // For .js files: use the current node binary directly
    const isSh = executablePath.endsWith('.sh');
    const isJs = executablePath.endsWith('.js');
    const cmd  = isSh ? '/bin/sh' : (isJs ? process.execPath : executablePath);
    const args = isSh ? [executablePath] : (isJs ? [executablePath] : []);

    let host;
    try {
      host = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (e) {
      resolve({ ok: false, error: `spawn 失败: ${e.message}`, elapsed: 0 });
      return;
    }

    const stderrChunks = [];
    host.stderr.on('data', (d) => stderrChunks.push(d));

    const timer = setTimeout(() => {
      host.kill();
      resolve({ ok: false, error: '超时 (5s)：未收到 pong', elapsed: Date.now() - t0,
        stderr: Buffer.concat(stderrChunks).toString() });
    }, 5000);

    // Send ping
    host.stdin.write(buildNativeMsg({ type: 'ping' }));

    // Read pong
    readNativeMsg(host.stdout)
      .then((msg) => {
        clearTimeout(timer);
        // Send SIGTERM to trigger graceful exit (host waits for SIGTERM after writing response)
        try { host.kill('SIGTERM'); } catch (_) {}
        if (msg.type === 'pong') {
          resolve({ ok: true, version: msg.version, elapsed: Date.now() - t0 });
        } else {
          resolve({ ok: false, error: `意外响应: ${JSON.stringify(msg)}`, elapsed: Date.now() - t0 });
        }
      })
      .catch((e) => {
        clearTimeout(timer);
        host.kill();
        resolve({ ok: false, error: e.message, elapsed: Date.now() - t0,
          stderr: Buffer.concat(stderrChunks).toString() });
      });
  });
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────
console.log();
console.log(`${c.bold}${c.cyan}=== WebTape Native Messaging 诊断报告 ===${c.reset}`);
console.log();

// ── [1] 配置文件 ─────────────────────────────────────────────────────────────
console.log(`${c.bold}[1] 配置文件${c.reset}`);
console.log(indent(ok(`期望插件 ID: ${c.cyan}${EXPECTED_EXTENSION_ID}${c.reset}（CLI 固定，勿改 config）`)));
if (!existsSync(CONFIG_PATH)) {
  console.log(indent(warn(`config.json 不存在（可选）: ${CONFIG_PATH}`)));
  console.log(indent(`  运行 ${c.cyan}webtape config${c.reset} 可保存 AI 后端`));
} else {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (cfg.extensionId) {
      console.log(indent(warn('config 中含已弃用字段 extensionId，请运行 webtape install 或手动删除该字段')));
    }
    if (cfg.aiBackend) console.log(indent(ok(`AI 后端: ${cfg.aiBackend}`)));
    else console.log(indent(`  ${c.gray}(未设置 aiBackend)${c.reset}`));
  } catch (e) {
    console.log(indent(err(`config.json 解析失败: ${e.message}`)));
    failCount++;
  }
}
console.log();

// ── [2] Manifest 文件 ────────────────────────────────────────────────────────
console.log(`${c.bold}[2] Native Messaging Host Manifest${c.reset}`);
const manifests = getManifestPaths();
let primaryManifestPath = null;

for (const { label, path: mPath } of manifests) {
  process.stdout.write(`  ${c.gray}[${label}]${c.reset}\n`);
  if (!check(existsSync(mPath), `文件存在: ${c.gray}${mPath}${c.reset}`, `文件不存在: ${mPath}`)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(mPath, 'utf-8'));
    check(true, 'JSON 有效', '');
  } catch (e) {
    console.log(indent(err(`JSON 解析失败: ${e.message}`)));
    failCount++;
    continue;
  }

  check(manifest.name === HOST_NAME,
    `name = ${manifest.name}`,
    `name 错误: ${manifest.name}（期望 ${HOST_NAME}）`);
  check(manifest.type === 'stdio',
    `type = stdio`,
    `type 错误: ${manifest.type}`);

  const origins = manifest.allowed_origins || [];
  const origin = origins[0] || '';
  const hasPending = origin.includes('PENDING_EXTENSION_ID');
  const hasId = /^chrome-extension:\/\/[a-z]{32}\/$/.test(origin);
  if (hasPending) {
    console.log(indent(err(`allowed_origins 含 PENDING_EXTENSION_ID — 未完成初始化`)));
    failCount++;
  } else if (!hasId) {
    console.log(indent(err(`allowed_origins 格式异常: ${origin}`)));
    failCount++;
  } else {
    const manifestId = origin.replace('chrome-extension://', '').replace('/', '');
    const idMatch = manifestId === EXPECTED_EXTENSION_ID;
    check(idMatch,
      `allowed_origins: ${c.cyan}${origin}${c.reset}`,
      `allowed_origins 与固定插件 ID 不符: manifest=${manifestId}, 期望=${EXPECTED_EXTENSION_ID}`);
  }

  const exePath = manifest.path || '';
  check(!!exePath && exePath !== '', `path: ${c.gray}${exePath}${c.reset}`, 'path 字段缺失');
  if (exePath && label === 'Chrome') primaryManifestPath = exePath;
}
console.log();

// ── [3] 可执行文件 ───────────────────────────────────────────────────────────
console.log(`${c.bold}[3] 可执行文件${c.reset}`);
const exePath = primaryManifestPath || DIST_INDEX;
console.log(indent(`Manifest 指向: ${c.gray}${exePath}${c.reset}`));

// Check if this is the wrapper script (preferred) or a direct .js file
const isWrapperScript = exePath.endsWith('.sh');
const isJsFile = exePath.endsWith('.js');

if (check(existsSync(exePath), '文件存在', `文件不存在: ${exePath}`)) {
  let isExecutable = false;
  try {
    accessSync(exePath, constants.X_OK);
    isExecutable = true;
  } catch {}
  check(isExecutable, '有执行权限 (chmod +x)', '无执行权限，需运行: chmod +x ' + exePath);

  try {
    const firstLine = readFileSync(exePath, 'utf-8').split('\n')[0];
    if (isWrapperScript) {
      check(firstLine === '#!/bin/sh', `Shebang: ${firstLine}`, `wrapper 脚本 shebang 异常: "${firstLine}"`);
    } else {
      const hasShebang = firstLine.startsWith('#!/usr/bin/env node') || firstLine.startsWith('#!/usr/local/bin/node');
      check(hasShebang, `Shebang: ${firstLine}`, `Shebang 缺失或异常: "${firstLine}"（期望 #!/usr/bin/env node）`);
    }
  } catch (e) {
    console.log(indent(err(`读取文件失败: ${e.message}`)));
    failCount++;
  }

  if (isWrapperScript) {
    // Verify wrapper script contains valid node path and points to dist/index.js
    try {
      const wrapperContent = readFileSync(exePath, 'utf-8');
      const execLine = wrapperContent.split('\n').find(l => l.startsWith('exec '));
      if (execLine) {
        // Extract node path from exec line (first quoted token)
        const nodePathMatch = execLine.match(/exec\s+'([^']+)'/);
        const scriptPathMatch = execLine.match(/exec\s+'[^']+'\s+'([^']+)'/);
        if (nodePathMatch) {
          const nodePath = nodePathMatch[1];
          check(existsSync(nodePath), `Node 二进制存在: ${c.gray}${nodePath}${c.reset}`,
            `Node 二进制不存在: ${nodePath} — 请重新运行 webtape install`);
        }
        if (scriptPathMatch) {
          const scriptPath = scriptPathMatch[1];
          check(existsSync(scriptPath), `Script 存在: ${c.gray}${scriptPath}${c.reset}`,
            `Script 不存在: ${scriptPath} — 请重新运行 webtape install`);
        }
      }
    } catch (e) {
      console.log(indent(err(`读取 wrapper 脚本失败: ${e.message}`)));
      failCount++;
    }
  }
}

if (isJsFile) {
  console.log(indent(warn(
    'Manifest 直接指向 .js 文件而非 wrapper shell 脚本。\n' +
    '      Chrome GUI 应用使用受限 PATH，可能找不到 node。\n' +
    '      请重新运行 webtape install 以生成 wrapper 脚本。'
  )));
  failCount++;
}

// Always verify dist/index.js exists (the script being executed)
if (!isJsFile) {
  check(existsSync(DIST_INDEX), `dist/index.js 存在: ${c.gray}${DIST_INDEX}${c.reset}`,
    `dist/index.js 不存在，需要先构建: npm run build`);
}
console.log();

// ── [4] 协议测试 ─────────────────────────────────────────────────────────────
console.log(`${c.bold}[4] 协议测试 (spawn host → ping → pong)${c.reset}`);

// Test via the wrapper script if it exists (mirrors Chrome's actual invocation)
// Fall back to direct node invocation for the .js file
const wrapperExists = existsSync(WRAPPER_SCRIPT);
const testPath = wrapperExists ? WRAPPER_SCRIPT : (existsSync(DIST_INDEX) ? DIST_INDEX : exePath);
console.log(indent(`测试路径: ${c.gray}${testPath}${c.reset}${wrapperExists ? '' : c.yellow + ' (wrapper 不存在，使用直接调用)' + c.reset}`));

if (!existsSync(testPath)) {
  console.log(indent(err('可执行文件不存在，跳过协议测试')));
  failCount++;
} else {
  console.log(indent(`${c.gray}正在 spawn host 并发送 ping (模拟 Chrome 调用方式)...${c.reset}`));
  const result = await protocolTest(testPath);
  if (result.ok) {
    console.log(indent(ok(`收到 pong ✓  version=${c.cyan}${result.version}${c.reset}  耗时=${result.elapsed}ms`)));
  } else {
    console.log(indent(err(`协议测试失败: ${result.error}`)));
    if (result.stderr) {
      console.log(indent(`${c.gray}stderr: ${result.stderr.trim()}${c.reset}`, 6));
    }
    failCount++;
  }
}
console.log();

// ── 总结 ──────────────────────────────────────────────────────────────────────
if (failCount === 0) {
  console.log(`${c.bold}${c.green}=== 所有检查通过 ✅  Native Messaging 链路预计可正常工作 ===${c.reset}`);
} else {
  console.log(`${c.bold}${c.red}=== 发现 ${failCount} 个问题 ❌  请按上方提示逐项修复 ===${c.reset}`);
}
console.log();
