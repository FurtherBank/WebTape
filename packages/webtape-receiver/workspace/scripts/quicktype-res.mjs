#!/usr/bin/env node
/**
 * 从录制会话目录的 responses/res_<id>.json 提取 body，调用 quicktype 生成同目录 res_<id>.d.ts。
 * 用法（在工作区根目录）：npm run qt:res -- <相对会话目录> <响应id>
 * 示例：npm run qt:res -- recordings/foo/0329-214049 0093
 * id 可传 0093 或 req_0093（统一按 res_0093.json 解析）。
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// 👁️ 规范化响应 id：兼容 req_0093 / 0093，文件始终为 res_<id>.json
function normalizeResId(raw) {
  if (raw == null || String(raw).trim() === '') {
    return null;
  }
  let s = String(raw).trim();
  if (/^req_/i.test(s)) {
    s = s.slice(4);
  }
  return s;
}

function tsTopLevelName(resId) {
  const safe = String(resId).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const base = safe || 'Body';
  return `Res${base}Body`;
}

function assertSessionInsideWorkspace(workspaceRoot, sessionAbs) {
  const ws = resolve(workspaceRoot);
  const abs = resolve(sessionAbs);
  const rel = relative(ws, abs);
  if (rel.startsWith('..') || rel === '' || rel.split(sep).some((p) => p === '..')) {
    console.error('❌ [Error] 会话目录必须位于工作区根目录之内（不得使用 .. 逃逸）。');
    console.error(`   workspaceRoot: ${ws}`);
    console.error(`   sessionDir:    ${abs}`);
    process.exit(1);
  }
}

/** @param {unknown} body */
function extractQuicktypePayload(body) {
  if (body !== null && typeof body === 'object') {
    return body;
  }
  if (typeof body === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      console.error('❌ [Error] body 为字符串但不是合法 JSON，无法生成类型。');
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
    if (parsed !== null && typeof parsed === 'object') {
      return parsed;
    }
    console.error('❌ [Error] body 经 JSON.parse 后不是 object/array，无法生成类型。');
    process.exit(1);
  }
  console.error('❌ [Error] body 既不是 object/array，也不是可解析为 JSON 的字符串。');
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const sessionRel = argv[0];
  const rawId = argv[1];

  if (!sessionRel || rawId == null) {
    console.error('用法: npm run qt:res -- <录制会话目录(相对工作区根)> <响应id>');
    console.error('示例: npm run qt:res -- recordings/site/0329-214049 0093');
    console.error('说明: id 可写 0093 或 req_0093；读取 responses/res_<id>.json，写入 responses/res_<id>.d.ts');
    process.exit(1);
  }

  const workspaceRoot = process.cwd();
  console.log('🚀 [Start] quicktype-res', { workspaceRoot, sessionRel, rawId });

  const resId = normalizeResId(rawId);
  if (!resId) {
    console.error('❌ [Error] 响应 id 无效');
    process.exit(1);
  }

  const sessionAbs = resolve(workspaceRoot, sessionRel);
  assertSessionInsideWorkspace(workspaceRoot, sessionAbs);

  const responsesDir = join(sessionAbs, 'responses');
  const resJsonPath = join(responsesDir, `res_${resId}.json`);
  const outDtsPath = join(responsesDir, `res_${resId}.d.ts`);

  if (!existsSync(resJsonPath)) {
    console.error(`❌ [Error] 未找到响应文件: ${resJsonPath}`);
    process.exit(1);
  }

  console.log('⚡️ [Step] 读取 JSON', resJsonPath);
  let doc;
  try {
    doc = JSON.parse(readFileSync(resJsonPath, 'utf8'));
  } catch (e) {
    console.error('❌ [Error] 无法解析 JSON 文件');
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (!Object.prototype.hasOwnProperty.call(doc, 'body')) {
    console.error('❌ [Error] JSON 顶层缺少 body 字段，无法推断响应体结构');
    process.exit(1);
  }

  const payload = extractQuicktypePayload(doc.body);
  const topLevel = tsTopLevelName(resId);

  const tmpName = `webtape-qt-${randomBytes(8).toString('hex')}.json`;
  const tmpPath = join(tmpdir(), tmpName);
  writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');

  const binName = process.platform === 'win32' ? 'quicktype.cmd' : 'quicktype';
  const qtBin = join(workspaceRoot, 'node_modules', '.bin', binName);

  if (!existsSync(qtBin)) {
    unlinkSync(tmpPath);
    console.error('❌ [Error] 未找到 quicktype，请在工作区根目录执行 npm install');
    console.error(`   期望路径: ${qtBin}`);
    process.exit(1);
  }

  const args = [
    tmpPath,
    '--lang',
    'typescript',
    '--just-types',
    '--top-level',
    topLevel,
    '-o',
    outDtsPath,
  ];

  try {
    console.log('🔌 [API] 调用 quicktype', { bin: qtBin, topLevel, out: outDtsPath });
    // 👁️ 使用工作区 node_modules/.bin/quicktype，与 ensureWorkspace + npm install 工具链一致
    execFileSync(qtBin, args, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      encoding: 'utf8',
    });
  } catch (e) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    console.error('❌ [Error] quicktype 执行失败');
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  try {
    unlinkSync(tmpPath);
  } catch {
    /* ignore */
  }

  console.log('✅ [Success] 已生成', outDtsPath);
}

main();
