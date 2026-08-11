#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CREDS_PATH = '/app/rootfs/data/creds.json';
const CACHE_PATH = '/app/rootfs/data/data/com.apple.android.music/files';
const WRAPPER = '/app/wrapper';
const HEALTH_PORT = 11020;

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

const healthState = { alive: false, lastRestart: null, restartCount: 0 };

const healthServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(healthState.alive ? 200 : 503);
    res.end(
      healthState.alive ? 'ok' : 'starting',
    );
  } else if (req.url === '/readyz') {
    const hasCreds = Boolean(readCreds());
    const cached = hasCachedSession();
    const ready = cached || hasCreds;
    res.writeHead(ready ? 200 : 503);
    res.end(ready ? 'ready' : 'no creds, no cache');
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[watcher] health server listening on :${HEALTH_PORT}`);
});
healthState.alive = true;

function runWrapper(args) {
  return new Promise((resolve) => {
    const child = spawn(WRAPPER, args, {
      stdio: 'inherit',
      detached: false,
    });
    let killedByWatcher = false;
    const interval = setInterval(() => {
      if (fs.existsSync(CREDS_PATH)) {
        console.log('[watcher] creds file appeared, killing wrapper');
        killedByWatcher = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 1000);
    child.on('exit', (code, signal) => {
      clearInterval(interval);
      resolve({ code, signal, killedByWatcher });
    });
  });
}

async function main() {
  console.log('[watcher] starting');

  while (true) {
    const creds = readCreds();
    let args = [];

    if (creds) {
      args = ['-L', `${creds.email}:${creds.password}`, '-F'];
      console.log('[watcher] starting wrapper with credentials');
    } else {
      console.log(
        hasCachedSession()
          ? '[watcher] starting wrapper (cached session present)'
          : '[watcher] starting wrapper (no creds, no cache yet)',
      );
    }

    healthState.lastRestart = new Date().toISOString();
    healthState.restartCount += 1;
    const result = await runWrapper(args);

    if (creds) {
      consumeCreds();
      console.log('[watcher] credentials consumed');
    }

    if (result.killedByWatcher) {
      console.log('[watcher] wrapper killed for cred rotation, restarting');
      continue;
    }

    console.log(
      `[watcher] wrapper exited code=${result.code} signal=${result.signal}, restarting in 2s`,
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main().catch((err) => {
  console.error('[watcher] fatal:', err);
  setInterval(() => {}, 1 << 30);
});
