import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectJavaScriptFiles, runCommand } from './ci-utils.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = await collectJavaScriptFiles(root);

if (files.length === 0) throw new Error('No shipped JavaScript files were found.');

for (const file of files) {
  const result = runCommand(process.execPath, ['--check', file], { cwd: root });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    throw new Error(`Syntax check failed: ${relative(root, file)}`);
  }
}

process.stdout.write(`Syntax check passed for ${files.length} shipped JavaScript files.\n`);
