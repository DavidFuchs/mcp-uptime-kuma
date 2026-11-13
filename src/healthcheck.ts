#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { healthcheckTarget } from './http-listen.js';

/**
 * The image's HEALTHCHECK. Exits 0 when healthy and 1 when not, which is all Docker reads.
 *
 * With no argument it works out what to probe from the container's main process (PID 1) and
 * the environment, and passes when that process is not serving HTTP. A URL given as the
 * argument is probed as it is.
 */

/** Docker gives the check 5 seconds (see the Dockerfile); answer before it gives up on us. */
const PROBE_TIMEOUT_MS = 4000;

function mainProcessCommandLine(): string {
  try {
    return readFileSync('/proc/1/cmdline', 'utf8').replaceAll('\0', ' ');
  } catch {
    // Not in a Linux container. There is no way to tell what to probe, so probe nothing.
    return '';
  }
}

let healthy: boolean;
try {
  const target = process.argv[2] ?? healthcheckTarget(mainProcessCommandLine(), process.env);
  healthy = target === null
    ? true
    : (await fetch(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok;
} catch {
  healthy = false;
}

process.exit(healthy ? 0 : 1);
