#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CREDS_PATH = '/app/rootfs/data/creds.json';
const CACHE_PATH = '/app/rootfs/data/data/com.apple.android.music/files';
const WRAPPER = '/app/wrapper';

function readCreds() {
  try {
    const raw = fs.readFileSync(CREDS_PATH, 'utf8');
    const creds = JSON.parse(raw);
    if (!creds.email || !creds.password) return null;
    return creds;
  } catch {
    return null;
  }
}

function hasCachedSession() {
  try {
    return fs.readdirSync(CACHE_PATH).length > 0;
  } catch {
    return false;
  }
}

function consumeCreds() {
  try {
    fs.unlinkSync(CREDS_PATH);
  } catch {
    /* ignore */
  }
}

function spawnWrapper(args) {
  const child = spawn(WRAPPER, args, {
    stdio: 'inherit',
    detached: false,
  });
  return new Promise((resolve) => {
    let exited = false;
    child.on('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
    setInterval(() => {
      if (exited) return;
      if (fs.existsSync(CREDS_PATH)) {
        console.log('[watcher] creds file appeared, killing wrapper');
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 1000).unref();
  });
}

async function main() {
  console.log('[watcher] starting');
  let restartingWithCreds = false;

  while (true) {
    let creds = readCreds();
    let args = [];

    if (creds && !restartingWithCreds) {
      args = ['-L', `${creds.email}:${creds.password}`, '-F'];
      restartingWithCreds = true;
      console.log('[watcher] starting wrapper with credentials');
    } else if (creds && restartingWithCreds) {
      args = [];
      consumeCreds();
      console.log('[watcher] credentials consumed; starting wrapper without -L');
    } else {
      args = [];
      console.log(
        hasCachedSession()
          ? '[watcher] starting wrapper (cached session present)'
          : '[watcher] starting wrapper (no creds, no cache)',
      );
    }

    const result = await spawnWrapper(args);

    if (restartingWithCreds) {
      restartingWithCreds = false;
    }

    if (creds) {
      consumeCreds();
    }

    if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
      console.log('[watcher] wrapper killed by signal, restarting');
      continue;
    }

    if (result.code === 0 && !readCreds() && hasCachedSession()) {
      console.log('[watcher] wrapper exited cleanly after cache write, exiting');
      process.exit(0);
    }

    console.log(`[watcher] wrapper exited code=${result.code} signal=${result.signal}, restarting in 2s`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error('[watcher] fatal:', err);
  process.exit(1);
});
