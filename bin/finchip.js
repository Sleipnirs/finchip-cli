#!/usr/bin/env node

const currentNodeVersion = process.version;
const {
  buildUnsupportedNodeError,
  isSupportedNodeVersion,
} = await import('../src/runtime-version.js');

if (!isSupportedNodeVersion(currentNodeVersion)) {
  const error = buildUnsupportedNodeError(currentNodeVersion);

  if (process.argv.includes('--json')) {
    process.stderr.write(`${JSON.stringify(error)}\n`);
  } else {
    process.stderr.write(`${error.message} Detected ${error.current}; required ${error.required}.\n`);
  }
  process.exit(1);
}

await import('../src/cli.js');
