#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const CREDS_PATH = '/app/rootfs/data/creds.json';
const CACHE_PATH = '/app/rootfs/data/data/com.apple.android.music/files';
const WRAPPER = '/app/wrapper';
const READY_PORT = 10020;
const READY_HOST = '127.0.0.1';

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
    const entries = fs.readdirSync(CACHE_PATH);
    return entries.length > 0;
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

async function waitForReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ port: READY_PORT, host: READY_HOST });
      sock.once('connect', () => {
        sock.end();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, 500).unref();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

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
