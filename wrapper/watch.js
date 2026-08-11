#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DATA_DIR = '/app/rootfs/data';
const CREDS_PATH = `${DATA_DIR}/creds.json`;
const TWOFA_DIR = `${DATA_DIR}/data/data/com.apple.android.music/files`;
const START_SENTINEL = `${DATA_DIR}/start.signal`;
const CACHE_DIR = TWOFA_DIR;
const WRAPPER = '/app/wrapper';
const HEALTH_PORT = 11020;

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readCreds() {
  if (!exists(CREDS_PATH)) return null;
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
    return fs.readdirSync(CACHE_DIR).length > 0;
  } catch {
    return false;
  }
}

function consume(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

const healthState = { alive: true, lastRestart: null, restartCount: 0 };

const healthServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(healthState.alive ? 200 : 503);
    res.end(healthState.alive ? 'ok' : 'starting');
  } else if (req.url === '/readyz') {
    const ready = hasCachedSession() || Boolean(readCreds());
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

function runWrapper(args) {
  return new Promise((resolve) => {
    const child = spawn(WRAPPER, args, {
      stdio: 'inherit',
      detached: false,
    });
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function runOnce(args, label) {
  healthState.lastRestart = new Date().toISOString();
  healthState.restartCount += 1;
  console.log(`[watcher] starting wrapper (${label})`);
  const result = await runWrapper(args);
  console.log(
    `[watcher] wrapper exited code=${result.code} signal=${result.signal} (${label})`,
  );
  return result;
}

async function main() {
  console.log('[watcher] starting; awaiting credentials and 2FA');

  while (true) {
    const creds = readCreds();
    const wantsLogin = creds !== null && exists(START_SENTINEL);

    if (wantsLogin) {
      consume(START_SENTINEL);
      consume(CREDS_PATH);
      consume(`${TWOFA_DIR}/2fa.txt`);

      const args = ['-L', `${creds.email}:${creds.password}`, '-F'];
      const result = await runOnce(args, 'login');
      if (!hasCachedSession()) {
        console.log(
          `[watcher] no cached session after login (code=${result.code}); waiting before retry`,
        );
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        console.log('[watcher] cached session present after login; healthy');
      }
      continue;
    }

    if (creds) {
      console.log(
        '[watcher] creds present but no 2FA yet; waiting for user to submit 2FA',
      );
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    if (hasCachedSession()) {
      const result = await runOnce([], 'cached-session');
      if (!hasCachedSession()) {
        console.log(
          `[watcher] cache gone after run (code=${result.code}); waiting before retry`,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
      continue;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((err) => {
  console.error('[watcher] fatal:', err);
  setInterval(() => {}, 1 << 30);
});