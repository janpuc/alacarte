import fsp from 'node:fs/promises'
import path from 'node:path'

import { emitEvent } from './eventBus.mjs'

const WRAPPER_DATA_HOST = '/wrapper-data'
const CREDS_FILE = path.join(WRAPPER_DATA_HOST, 'creds.json')

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

export async function startWrapperLogin({ email, password }) {
  if (active) return { ok: false, reason: 'login already in progress' }

  active = { status: { state: 'starting', message: 'queueing credentials' } }
  emitStatus({ state: 'starting' })

  try {
    await fsp.mkdir(WRAPPER_DATA_HOST, { recursive: true })
    await fsp.writeFile(
      CREDS_FILE,
      JSON.stringify({ email, password, ts: Date.now() }),
      { mode: 0o600 },
    )
    emitStatus({ state: 'queued', message: 'credentials written; wrapper watcher will pick up' })
    return { ok: true }
  } catch (err) {
    active = null
    emitEvent('wrapper.login', { state: 'failed', message: err.message })
    return { ok: false, reason: err.message }
  }
}

export async function submit2FA(code) {
  if (!active) return { ok: false, reason: 'no login in progress' }
  try {
    const dir = path.join(WRAPPER_DATA_HOST, 'data', 'data', 'com.apple.android.music', 'files')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, '2fa.txt'), code.trim(), { mode: 0o600 })
    emitStatus({ state: 'awaiting-2fa', message: '2FA code written' })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
}

export async function cancelLogin() {
  active = null
  try {
    await fsp.unlink(CREDS_FILE)
  } catch {
    /* ignore */
  }
  emitEvent('wrapper.login', { state: 'cancelled' })
  return { ok: true }
}

export function wrapperDataMountExists() {
  return true
}
