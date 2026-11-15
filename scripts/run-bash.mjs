#!/usr/bin/env node
// Runs a bash script from an npm script on every platform.
//
// npm runs package.json scripts through cmd.exe on Windows, which cannot run `./run-tests.sh`,
// and a plain `bash` there usually resolves to C:\Windows\System32\bash.exe — WSL, a different
// machine with its own node and docker — rather than Git Bash. So on Windows this finds the
// bash that ships with Git for Windows, through `git --exec-path`; elsewhere it uses `bash`.
//
// Usage: node scripts/run-bash.mjs <script.sh> [args...]
// Arguments after the script are passed through, so `npm run test:llm -- --repeat 3` works.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function findBash() {
  if (process.platform !== 'win32') return 'bash';

  const candidates = [];
  try {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core -> C:/Program Files/Git/bin/bash.exe
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    candidates.push(join(execPath, '..', '..', '..', 'bin', 'bash.exe'));
  } catch {
    // git is not on PATH; try the default install locations below.
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'), join(base, 'Programs', 'Git', 'bin', 'bash.exe'));
  }

  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error(
      'Could not find Git Bash. These test scripts need bash: install Git for Windows ' +
        '(https://git-scm.com/download/win), or run them from WSL.'
    );
    process.exit(1);
  }
  return found;
}

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node scripts/run-bash.mjs <script.sh> [args...]');
  process.exit(2);
}

const child = spawn(findBash(), [resolve(script), ...args], { stdio: 'inherit' });

// Ctrl+C reaches the script too, and the scripts tear the test container down on it. Exiting
// here first would hand the terminal back mid-cleanup, so wait for the script to finish instead.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});

child.on('error', (error) => {
  console.error(`Failed to start bash: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === 'SIGINT' ? 130 : 1));
});
