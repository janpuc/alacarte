import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'

const WRAPPER_DATA_HOST = process.env.WRAPPER_DATA_HOST || '/wrapper-data'
const CREDS_FILE = path.join(WRAPPER_DATA_HOST, 'creds.json')
const TWOFA_PIPE = path.join(WRAPPER_DATA_HOST, 'twofa.pipe')
const CACHE_DIR = path.join(
  WRAPPER_DATA_HOST,
  'data',
  'data',
  'com.apple.android.music',
  'files',
)
const READY_TIMEOUT_MS = 5 * 60 * 1000
const READY_POLL_MS = 1500

const DEBUG = process.env.WRAPPER_LOGIN_DEBUG === 'true'

function debug(...args) {
  if (!DEBUG) return
  console.log('[wrapperLogin]', ...args)
}

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
  debug('emit phase=', active.status.phase, 'msg=', active.status.message)
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

async function hasCachedSession() {
  try {
    const entries = await fsp.readdir(CACHE_DIR)
    return entries.length > 0
  } catch {
    return false
  }
}

let readyTimer = null

function stopReadyPoll() {
  if (readyTimer) {
    clearInterval(readyTimer)
    readyTimer = null
  }
}

function startReadyPoll() {
  stopReadyPoll()
  const startedAt = Date.now()
  const poll = async () => {
    if (!active) {
      stopReadyPoll()
      return
    }
    if (Date.now() - startedAt > READY_TIMEOUT_MS) {
      stopReadyPoll()
      emitStatus({ phase: 'failed', message: 'login timed out after 5 minutes' })
      active = null
      return
    }
    if (await hasCachedSession()) {
      stopReadyPoll()
      emitStatus({ phase: 'ready', message: 'signed in successfully' })
      active = null
    }
  }
  readyTimer = setInterval(poll, READY_POLL_MS)
}

export async function startWrapperLogin({ email, password }) {
  if (active) {
    debug('startWrapperLogin rejected: already in progress')
    return { ok: false, reason: 'login already in progress' }
  }

  stopReadyPoll()
  await unlinkIfExists(TWOFA_PIPE)
  await unlinkIfExists(CREDS_FILE)

  debug('startWrapperLogin begin; host=', WRAPPER_DATA_HOST)
  active = { status: { phase: 'signing-in', message: 'sending credentials to Apple' } }
  emitStatus({ phase: 'signing-in' })

  try {
    await fsp.mkdir(WRAPPER_DATA_HOST, { recursive: true })
    if (await hasCachedSession()) {
      debug('cached session already present; emitting ready')
      emitStatus({ phase: 'ready', message: 'already signed in' })
      active = null
      return { ok: true }
    }
    await fsp.writeFile(
      CREDS_FILE,
      JSON.stringify({ email, password, ts: Date.now() }),
      { mode: 0o600 },
    )
    debug('wrote creds.json at', CREDS_FILE)
    emitStatus({
      phase: '2fa-required',
      message:
        'check your trusted Apple device for a 6-digit verification code, then enter it here',
    })
    return { ok: true }
  } catch (err) {
    debug('startWrapperLogin failed:', err)
    active = null
    emitEvent('wrapper.login', { phase: 'failed', message: err.message })
    return { ok: false, reason: err.message }
  }
}

export async function submit2FA(code) {
  if (!active) {
    debug('submit2FA rejected: no login in progress')
    return { ok: false, reason: 'no login in progress' }
  }
  try {
    const cleaned = code.replace(/\s+/g, '')
    await fsp.writeFile(TWOFA_PIPE, cleaned, { mode: 0o600 })
    debug('wrote twofa.pipe')
    emitStatus({
      phase: 'verifying-2fa',
      message: '2FA submitted; completing sign-in',
    })
    if (await hasCachedSession()) {
      emitStatus({ phase: 'ready', message: 'already signed in' })
      active = null
    } else {
      startReadyPoll()
    }
    return { ok: true }
  } catch (err) {
    debug('submit2FA failed:', err)
    return { ok: false, reason: err.message }
  }
}

export async function cancelLogin() {
  stopReadyPoll()
  active = null
  await Promise.all([unlinkIfExists(CREDS_FILE), unlinkIfExists(TWOFA_PIPE)])
  emitEvent('wrapper.login', { phase: 'cancelled' })
  return { ok: true }
}

export function wrapperDataMountExists() {
  return true
}