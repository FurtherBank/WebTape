import AdmZip from 'adm-zip';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, cpSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const workspaceDir = join(rootDir, 'workspace');
const distDir = join(rootDir, 'dist');

async function packWorkspace() {
  // Copy non-TS assets (EJS templates) that tsc does not handle
  const srcTemplates = join(rootDir, 'src', 'templates');
  const distTemplates = join(distDir, 'templates');
  if (existsSync(srcTemplates)) {
    mkdirSync(distTemplates, { recursive: true });
    cpSync(srcTemplates, distTemplates, { recursive: true });
    console.log('📋 Copied templates → dist/templates');
  }

  console.log('📦 Packing workspace template...');
  
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const zip = new AdmZip();
  zip.addLocalFolder(workspaceDir);
  
  // Add overwrite_list.json separately so it's in the zip root but not in the extracted workspace folder
  const overwriteListPath = join(rootDir, 'src', 'overwrite_list.json');
  if (existsSync(overwriteListPath)) {
    zip.addLocalFile(overwriteListPath);
  }

  const zipPath = join(distDir, 'workspace.zip');
  zip.writeZip(zipPath);
  
  console.log(`✅ Workspace template packed to ${zipPath}`);
}

packWorkspace().catch(err => {
  console.error('❌ Failed to pack workspace:', err);
  process.exit(1);
});
