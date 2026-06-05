#!/usr/bin/env node
/**
 * Process supervisor for brain.py (copied verbatim from MediaHubAccess-bot).
 *
 *  - Spawns `python brain.py` (using the project venv if present).
 *  - On exit code 99 → respawn (admin clicked "Restart brain" → /shutdown).
 *  - On exit code 0  → don't respawn (clean intentional stop).
 *  - On crash       → respawn with backoff (max 2s).
 *
 * Run with:  npm run brain
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const VENV_WIN = resolve(HERE, 'venv', 'Scripts', 'python.exe');
const VENV_NIX = resolve(HERE, 'venv', 'bin', 'python');
const PYTHON = existsSync(VENV_WIN) ? VENV_WIN : existsSync(VENV_NIX) ? VENV_NIX : 'python';

let child = null;
let stopped = false;

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function spawnBrain() {
  console.log(`[supervisor ${ts()}] spawning ${PYTHON} brain.py`);
  child = spawn(PYTHON, ['brain.py'], { stdio: 'inherit', cwd: HERE });

  child.on('exit', (code, signal) => {
    child = null;
    console.log(`[supervisor ${ts()}] brain exited (code=${code}, signal=${signal})`);
    if (stopped) return;

    if (code === 0) {
      console.log(`[supervisor ${ts()}] clean exit (code 0) — not respawning.`);
      process.exit(0);
    }

    const delay = code === 99 ? 800 : 2000;
    console.log(`[supervisor ${ts()}] respawning in ${delay}ms…`);
    setTimeout(spawnBrain, delay);
  });

  child.on('error', (err) => {
    console.error(`[supervisor ${ts()}] spawn error:`, err.message);
  });
}

function shutdown(reason) {
  if (stopped) return;
  stopped = true;
  console.log(`[supervisor ${ts()}] shutting down (${reason})`);
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

spawnBrain();
