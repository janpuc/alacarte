#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const DATA_DIR = '/app/rootfs/data';
const CREDS_PATH = `${DATA_DIR}/creds.json`;
const TWOFA_PIPE = `${DATA_DIR}/twofa.pipe`;
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

function readTwofa() {
  if (!exists(TWOFA_PIPE)) return null;
  try {
    const raw = fs.readFileSync(TWOFA_PIPE, 'utf8');
    const code = raw.replace(/\s+/g, '');
    if (!/^\d{4,8}$/.test(code)) return null;
    return code;
  } catch (err) {
    debug('readTwofa error:', err.message);
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
    twoFaPipe: exists(TWOFA_PIPE),
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

function redactArgs(args) {
  return args.map((a) => {
    if (typeof a !== 'string') return a;
    const colon = a.indexOf(':');
    if (colon !== -1 && a.includes('@')) return `${a.slice(0, colon)}:***`;
    return a;
  });
}

let activeChild = null;

function runWrapperLogin(creds, twofa) {
  return new Promise((resolve) => {
    const args = ['-L', `${creds.email}:${creds.password}`];
    debug('spawning wrapper with args=', redactArgs(args));
    const devnull = fs.openSync('/dev/null', 'w');
    const child = spawn(WRAPPER, args, {
      stdio: ['pipe', devnull, devnull],
      detached: false,
    });
    activeChild = child;
    let stdinClosed = false;
    function closeStdin() {
      if (stdinClosed) return;
      stdinClosed = true;
      try { child.stdin.end(); } catch {}
    }
    if (twofa) {
      child.stdin.write(twofa + '\n', (err) => {
        if (err) debug('stdin write error:', err.message);
        closeStdin();
      });
    } else {
      const stdinPoll = setInterval(() => {
        const code = readTwofa();
        if (!code) return;
        clearInterval(stdinPoll);
        log('twofa code arrived; writing to wrapper stdin');
        child.stdin.write(code + '\n', (err) => {
          if (err) debug('stdin write error:', err.message);
          closeStdin();
        });
      }, 500);
      child.stdin.on('error', () => {
        clearInterval(stdinPoll);
      });
    }
    child.on('exit', (code, signal) => {
      activeChild = null;
      try { fs.closeSync(devnull); } catch {}
      resolve({ code, signal });
    });
  });
}

function runWrapperCached() {
  return new Promise((resolve) => {
    debug('spawning wrapper (cached session)');
    const devnull = fs.openSync('/dev/null', 'w');
    const child = spawn(WRAPPER, [], {
      stdio: ['ignore', devnull, devnull],
      detached: false,
    });
    activeChild = child;
    child.on('exit', (code, signal) => {
      activeChild = null;
      try { fs.closeSync(devnull); } catch {}
      resolve({ code, signal });
    });
  });
}

async function runLogin(creds, twofa, label) {
  healthState.lastRestart = new Date().toISOString();
  healthState.restartCount += 1;
  log(`starting wrapper (${label})`);
  const result = twofa
    ? await runWrapperLogin(creds, twofa)
    : await runWrapperLogin(creds, null);
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
      const twofa = readTwofa();
      log(`creds present, twofa=${twofa ? 'ready' : 'waiting'}; launching wrapper`);
      let cancelled = false;
      const cancelPoll = setInterval(() => {
        if (!exists(CREDS_PATH)) {
          cancelled = true;
          log('creds.json disappeared (cancel); killing wrapper');
          if (activeChild && !activeChild.killed) {
            try { activeChild.kill('SIGTERM'); } catch {}
          }
          clearInterval(cancelPoll);
        }
      }, 500);
      const result = await runLogin(creds, twofa, 'login');
      clearInterval(cancelPoll);
      consume(CREDS_PATH);
      consume(TWOFA_PIPE);
      if (cancelled) {
        log('login cancelled');
        continue;
      }
      if (!hasCachedSession()) {
        log(`no cached session after login (code=${result.code}); waiting 5s before retry`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        log('cached session present after login; healthy');
      }
      continue;
    }

    if (hasCachedSession()) {
      const result = await runWrapperCached();
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