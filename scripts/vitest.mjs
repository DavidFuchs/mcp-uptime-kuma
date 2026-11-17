#!/usr/bin/env node
// Runs Vitest from an npm script on every platform.
//
// Windows: when the working directory's drive letter is lowercase (`c:\…`, which VS Code and the
// shells it starts commonly pass on), Vitest loads its runner twice: once through its own root,
// which it spells `C:/…`, and once through paths resolved from the working directory. Every
// `describe` then fails with "Cannot read properties of undefined (reading 'config')". The
// config file runs too late to fix it, so this starts Vitest with the drive spelled as Vitest
// spells it. Elsewhere, and with an uppercase drive, the working directory is passed on as is.
//
// Usage: node scripts/vitest.mjs [vitest args...], e.g. `node scripts/vitest.mjs run --coverage`.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const cwd =
  process.platform === 'win32' && /^[a-z]:/.test(process.cwd())
    ? process.cwd()[0].toUpperCase() + process.cwd().slice(1)
    : process.cwd();

// Resolved from the corrected directory, not from this file: this file's own path still carries
// the drive letter as it was typed, and loading Vitest through it would bring the problem back.
const vitest = join(dirname(createRequire(join(cwd, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
const child = spawn(process.execPath, [vitest, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });

// Ctrl+C reaches Vitest too (same terminal), and watch mode tidies up on it; wait for it to exit.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});

child.on('error', (error) => {
  console.error(`Failed to start vitest: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
});
