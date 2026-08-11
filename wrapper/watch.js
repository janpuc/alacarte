#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DATA_DIR = '/app/rootfs/data';
const CREDS_PATH = `${DATA_DIR}/creds.json`;
const TWOFA_DIR = `${DATA_DIR}/data/data/com.apple.android.music/files`;
const CACHE_DIR = TWOFA_DIR;
const WRAPPER = '/app/wrapper';
const HEALTH_PORT = 11020;
const DEBUG = process.env.WRAPPER_DEBUG === 'true';

function log(...args) {
  console.log(`[watcher ${new Date().toISOString()}]`, ...args);
}

function debug(...args) {
  if (!DEBUG) return;
  log('[debug]', ...args);
}

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
  } catch (err) {
    debug('readCreds error:', err.message);
    return null;
  }
}

function hasCachedSession() {
  try {
    return fs.readdirSync(CACHE_DIR).length > 0;
  } catch (err) {
    debug('hasCachedSession error:', err.message);
    return false;
  }
}

function consume(p) {
  try {
    fs.unlinkSync(p);
    debug('consumed', p);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      debug('consume error for', p, err.message);
      throw err;
    }
  }
}

function snapshotState() {
  return {
    creds: exists(CREDS_PATH),
    twoFa: exists(`${TWOFA_DIR}/2fa.txt`),
    cache: hasCachedSession(),
  };
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
  } else if (req.url === '/debug/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshotState(), null, 2));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  log(`health server listening on :${HEALTH_PORT} debug=${DEBUG}`);
});

function runWrapper(args) {
  return new Promise((resolve) => {
    debug('spawning wrapper with args=', args);
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
  log(`starting wrapper (${label}) args=${JSON.stringify(args)}`);
  const result = await runWrapper(args);
  log(`wrapper exited code=${result.code} signal=${result.signal} (${label})`);
  return result;
}

async function chownTree(p, uid, gid) {
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      const child = `${p}/${e.name}`;
      fs.chownSync(child, uid, gid);
      if (e.isDirectory()) await chownTree(child, uid, gid);
    }
  } catch (err) {
    debug('chownTree skip', p, err.message);
  }
}

async function main() {
  log('starting; awaiting credentials');
  try {
    fs.chownSync(DATA_DIR, 1000, 1000);
    await chownTree(DATA_DIR, 1000, 1000);
    log('chowned data tree to 1000:1000');
  } catch (err) {
    log('chown failed:', err.message);
  }
  log('initial state:', JSON.stringify(snapshotState()));

  let lastHeartbeat = 0;

  while (true) {
    const creds = readCreds();

    if (DEBUG && Date.now() - lastHeartbeat > 5000) {
      log('heartbeat state=', JSON.stringify(snapshotState()));
      lastHeartbeat = Date.now();
    }

    if (creds) {
      log('creds present — starting wrapper with -L -F (it will poll 2fa.txt)');
      const args = ['-L', `${creds.email}:${creds.password}`, '-F'];
      const result = await runOnce(args, 'login');
      consume(CREDS_PATH);
      consume(`${TWOFA_DIR}/2fa.txt`);
      if (!hasCachedSession()) {
        log(`no cached session after login (code=${result.code}); waiting 5s before retry`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        log('cached session present after login; healthy');
      }
      continue;
    }

    if (hasCachedSession()) {
      const result = await runOnce([], 'cached-session');
      if (!hasCachedSession()) {
        log(`cache gone after run (code=${result.code}); waiting 5s before retry`);
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