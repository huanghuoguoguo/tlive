#!/usr/bin/env node
// postinstall: copy reference docs to ~/.tlive/docs/
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function copyReferenceDocs() {
  const docsDir = join(homedir(), '.tlive', 'docs');
  mkdirSync(docsDir, { recursive: true });

  const refsDir = join(__dirname, '..', 'references');
  const docs = ['setup-guides.md', 'token-validation.md', 'troubleshooting.md'];
  for (const doc of docs) {
    const src = join(refsDir, doc);
    const dest = join(docsDir, doc);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  // Copy config template so the skill can reference exact variable names
  const configExample = join(__dirname, '..', 'config.env.example');
  const configDest = join(docsDir, 'config.env.example');
  if (existsSync(configExample)) {
    copyFileSync(configExample, configDest);
  }

  console.log(`Reference docs installed to ${docsDir}`);
}

async function main() {
  console.log('Setting up TLive...');
  copyReferenceDocs();
  console.log('\nTLive setup complete.');
  console.log('Next steps:');
  console.log('  1. tlive setup              — configure IM platforms');
  console.log('  2. tlive install skills     — install Claude Code skill');
}

main().catch(console.error);
