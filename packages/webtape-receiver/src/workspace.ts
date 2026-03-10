import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import AdmZip from 'adm-zip';
import { minimatch } from 'minimatch';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WorkspacePaths {
  root: string;
  recordings: string;
}

/**
 * Resolve the WebTape workspace root. Priority:
 * 1. Explicit --workspace CLI flag
 * 2. ~/Desktop/WebTape (works on macOS and Windows)
 */
export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit) return explicit;
  return join(homedir(), 'Desktop', 'WebTape');
}

/**
 * Get the path to the bundled workspace.zip.
 */
function getBundledZipPath(): string {
  // In development, it's in dist/
  // In production (after build), it's also in dist/ relative to this file
  return join(__dirname, 'workspace.zip');
}

/**
 * Ensure the workspace directory tree exists and return the resolved paths.
 */
export function ensureWorkspace(root: string, version: string): WorkspacePaths {
  const recordings = join(root, 'recordings');
  const pkgPath = join(root, 'package.json');
  const zipPath = getBundledZipPath();

  if (!existsSync(zipPath)) {
    console.error(chalk.red(`  ✗ 错误: 找不到工作区模板压缩包: ${zipPath}`));
    process.exit(1);
  }

  const zip = new AdmZip(zipPath);
  let needsInstall = false;

  if (!existsSync(root)) {
    // First time initialization
    mkdirSync(root, { recursive: true });
    console.log(chalk.green('  📁 已创建工作区目录: ' + root));
    
    // Extract all entries except overwrite_list.json
    const allEntries = zip.getEntries();
    for (const entry of allEntries) {
      if (entry.entryName !== 'overwrite_list.json') {
        zip.extractEntryTo(entry, root, false, true);
      }
    }
    console.log(chalk.green('  📄 已初始化工作区文件'));
    needsInstall = true;
  } else {
    // Check for updates
    let currentVersion = '0.0.0';
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        currentVersion = pkg.version || '0.0.0';
      } catch {
        // ignore
      }
    }

    if (currentVersion !== version) {
      console.log(chalk.cyan(`  🔄 检测到工作区版本更新 (${currentVersion} -> ${version})`));
      
      // Read overwrite list from zip
      const overwriteListEntry = zip.getEntry('overwrite_list.json');
      let overwriteList: string[] = ['package.json', 'AGENTS.md']; // Default
      
      if (overwriteListEntry) {
        try {
          overwriteList = JSON.parse(overwriteListEntry.getData().toString('utf-8'));
        } catch {
          // ignore
        }
      }

  // Overwrite files matching glob patterns
      const allEntries = zip.getEntries();
      const updatedFiles: string[] = [];
      for (const pattern of overwriteList) {
        for (const entry of allEntries) {
          // Skip directories and the overwrite_list.json itself
          if (entry.isDirectory || entry.entryName === 'overwrite_list.json') continue;
          
          if (minimatch(entry.entryName, pattern)) {
            zip.extractEntryTo(entry, root, false, true);
            updatedFiles.push(entry.entryName);
          }
        }
      }

      if (updatedFiles.length > 0) {
        console.log(chalk.gray(`    - 已更新: ${updatedFiles.join(', ')}`));
      }

      // Update version in package.json
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          pkg.version = version;
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
          needsInstall = true;
        } catch {
          // ignore
        }
      }
    }
  }

  // Ensure recordings directory exists
  if (!existsSync(recordings)) {
    mkdirSync(recordings, { recursive: true });
  }

  // Run npm install if needed
  if (needsInstall) {
    console.log(chalk.cyan('  📦 正在安装工作区依赖 (npm install)...'));
    try {
      execSync('npm install', { cwd: root, stdio: 'inherit' });
      console.log(chalk.green('  ✅ 依赖安装完成'));
    } catch (err) {
      console.error(chalk.yellow('  ⚠️ 依赖安装失败，请手动在工作区运行 npm install'));
    }
  }

  return { root, recordings };
}
