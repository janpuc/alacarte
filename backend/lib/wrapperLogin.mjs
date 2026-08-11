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

export async function startWrapperLogin({ email, password }) {
  if (active) {
    debug('startWrapperLogin rejected: already in progress')
    return { ok: false, reason: 'login already in progress' }
  }

  debug('startWrapperLogin begin; host=', WRAPPER_DATA_HOST)
  active = { status: { phase: 'signing-in', message: 'sending credentials to Apple' } }
  emitStatus({ phase: 'signing-in' })

  try {
    await fsp.mkdir(WRAPPER_DATA_HOST, { recursive: true })
    await fsp.mkdir(path.dirname(TWOFA_FILE), { recursive: true })
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
    await fsp.writeFile(TWOFA_FILE, code.trim(), { mode: 0o600 })
    debug('wrote 2fa.txt at', TWOFA_FILE)
    emitStatus({
      phase: 'verifying-2fa',
      message: '2FA submitted; completing sign-in',
    })
    return { ok: true }
  } catch (err) {
    debug('submit2FA failed:', err)
    return { ok: false, reason: err.message }
  }
}

export async function cancelLogin() {
  active = null
  await Promise.all([unlinkIfExists(CREDS_FILE), unlinkIfExists(TWOFA_FILE)])
  emitEvent('wrapper.login', { phase: 'cancelled' })
  return { ok: true }
}

export function wrapperDataMountExists() {
  return true
}