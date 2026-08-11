const DISABLED_REASON =
  'Wrapper login runs as a Kubernetes sidecar — credentials are written by the wrapper itself from /wrapper-data. Submit Apple credentials via the UI; the sidecar polls and authenticates.'

let hardBlockReason = null

export function clearHardBlock() {
  hardBlockReason = null
}

export function getHardBlock() {
  return hardBlockReason
}

export function getLoginStatus() {
  return { inProgress: false, mode: 'sidecar', reason: DISABLED_REASON }
}

export async function isDockerReachable() {
  return false
}

export async function startWrapperLogin() {
  return { ok: false, reason: DISABLED_REASON }
}

export async function submit2FA() {
  return { ok: false, reason: DISABLED_REASON }
}

export async function cancelLogin() {
  return { ok: true }
}

export function wrapperDataMountExists() {
  return true
}
