import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'

const WRAPPER_DATA_HOST = process.env.WRAPPER_DATA_HOST || '/wrapper-data'
const CREDS_FILE = path.join(WRAPPER_DATA_HOST, 'creds.json')
const TWOFA_FILE = path.join(
  WRAPPER_DATA_HOST,
  'data',
  'data',
  'com.apple.android.music',
  'files',
  '2fa.txt',
)
const START_SENTINEL = path.join(WRAPPER_DATA_HOST, 'start.signal')

let hardBlockReason = null

let active = null

export function clearHardBlock() {
  hardBlockReason = null
}

export function getHardBlock() {
  return hardBlockReason
}

function emitStatus(patch) {
  if (!active) return
  active.status = { ...active.status, ...patch, ts: Date.now() }
  emitEvent('wrapper.login', active.status)
}

export function getLoginStatus() {
  if (!active) return { inProgress: false }
  return { inProgress: true, status: active.status }
}

export async function isDockerReachable() {
  try {
    await fsp.access(WRAPPER_DATA_HOST, fsp.constants.W_OK)
    return true
  } catch {
    return false
  }
}

async function unlinkIfExists(p) {
  try {
    await fsp.unlink(p)
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
  }
}

export async function startWrapperLogin({ email, password }) {
  if (active) return { ok: false, reason: 'login already in progress' }

  active = { status: { phase: 'preparing', message: 'queueing credentials' } }
  emitStatus({ phase: 'preparing' })

  try {
    await fsp.mkdir(WRAPPER_DATA_HOST, { recursive: true })
    await fsp.mkdir(path.dirname(TWOFA_FILE), { recursive: true })
    await unlinkIfExists(START_SENTINEL)
    await fsp.writeFile(
      CREDS_FILE,
      JSON.stringify({ email, password, ts: Date.now() }),
      { mode: 0o600 },
    )
    emitStatus({
      phase: '2fa-required',
      message:
        'credentials written — submit the 2FA code from your Apple device to start the wrapper',
    })
    return { ok: true }
  } catch (err) {
    active = null
    emitEvent('wrapper.login', { phase: 'failed', message: err.message })
    return { ok: false, reason: err.message }
  }
}

export async function submit2FA(code) {
  if (!active) return { ok: false, reason: 'no login in progress' }
  try {
    await fsp.writeFile(TWOFA_FILE, code.trim(), { mode: 0o600 })
    await fsp.writeFile(START_SENTINEL, JSON.stringify({ ts: Date.now() }), {
      mode: 0o600,
    })
    emitStatus({
      phase: 'verifying-2fa',
      message: '2FA written — wrapper starting',
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

export async function cancelLogin() {
  active = null
  await Promise.all([
    unlinkIfExists(CREDS_FILE),
    unlinkIfExists(TWOFA_FILE),
    unlinkIfExists(START_SENTINEL),
  ])
  emitEvent('wrapper.login', { phase: 'cancelled' })
  return { ok: true }
}

export function wrapperDataMountExists() {
  return true
}