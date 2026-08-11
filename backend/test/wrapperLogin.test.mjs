import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'alacarte-login-'))
process.env.WRAPPER_DATA_HOST = tmp

const { onEvent } = await import('../lib/eventBus.mjs')
const {
  startWrapperLogin,
  submit2FA,
  cancelLogin,
  getLoginStatus,
  isDockerReachable,
  clearHardBlock,
  getHardBlock,
} = await import('../lib/wrapperLogin.mjs')

const events = []
const off = onEvent((ev) => events.push(ev))

function phaseEvents() {
  return events
    .filter((e) => e.type === 'wrapper.login')
    .map((e) => e.data)
}

test.after(() => {
  off()
})

test('isDockerReachable returns true when WRAPPER_DATA_HOST is writable', async () => {
  assert.equal(await isDockerReachable(), true)
})

test('startWrapperLogin rejects while another login is active', async () => {
  clearHardBlock()
  const r1 = await startWrapperLogin({ email: 'a@b.com', password: 'pw1' })
  assert.equal(r1.ok, true)
  const r2 = await startWrapperLogin({ email: 'a@b.com', password: 'pw2' })
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /already in progress/i)
  await cancelLogin()
})

test('startWrapperLogin writes creds.json and emits 2fa-required phase', async () => {
  events.length = 0
  clearHardBlock()
  const r = await startWrapperLogin({ email: 'user@apple.com', password: 'sekret' })
  assert.equal(r.ok, true)

  const credsPath = path.join(tmp, 'creds.json')
  const credsRaw = await fsp.readFile(credsPath, 'utf8')
  const creds = JSON.parse(credsRaw)
  assert.equal(creds.email, 'user@apple.com')
  assert.equal(creds.password, 'sekret')
  assert.equal(typeof creds.ts, 'number')

  const stat = await fsp.stat(credsPath)
  assert.equal(stat.mode & 0o777, 0o600)

  const phases = phaseEvents().map((d) => d.phase)
  assert.ok(phases.includes('2fa-required'), `got phases: ${JSON.stringify(phases)}`)

  for (const d of phaseEvents()) {
    assert.ok(
      d.phase !== undefined,
      `event must carry phase, not state: ${JSON.stringify(d)}`,
    )
    assert.equal(d.state, undefined)
  }

  const status = getLoginStatus()
  assert.equal(status.inProgress, true)
  assert.equal(status.status.phase, '2fa-required')

  await cancelLogin()
})

test('submit2FA writes twofa.pipe and emits verifying-2fa', async () => {
  await cancelLogin()
  events.length = 0

  const start = await startWrapperLogin({ email: 'x@y.com', password: 'pw' })
  assert.equal(start.ok, true)
  events.length = 0

  const r = await submit2FA('123456')
  assert.equal(r.ok, true)

  const pipePath = path.join(tmp, 'twofa.pipe')
  assert.equal(await fsp.readFile(pipePath, 'utf8'), '123456')
  const pipeStat = await fsp.stat(pipePath)
  assert.equal(pipeStat.mode & 0o777, 0o600)

  const phases = phaseEvents().map((d) => d.phase)
  assert.ok(phases.includes('verifying-2fa'), `got: ${JSON.stringify(phases)}`)

  await cancelLogin()
})

test('submit2FA strips whitespace from the 2FA code', async () => {
  await cancelLogin()
  await startWrapperLogin({ email: 'x@y.com', password: 'pw' })
  const r = await submit2FA('  987654 \n')
  assert.equal(r.ok, true)
  const pipePath = path.join(tmp, 'twofa.pipe')
  assert.equal(await fsp.readFile(pipePath, 'utf8'), '987654')
  await cancelLogin()
})

test('submit2FA rejects when no login is in progress', async () => {
  await cancelLogin()
  const r = await submit2FA('000000')
  assert.equal(r.ok, false)
  assert.match(r.reason, /no login in progress/i)
})

test('cancelLogin removes creds.json and twofa.pipe', async () => {
  await startWrapperLogin({ email: 'x@y.com', password: 'pw' })
  await submit2FA('111111')

  for (const rel of ['creds.json', 'twofa.pipe']) {
    const p = path.join(tmp, rel)
    assert.equal(await fsp.access(p).then(() => true, () => false), true, rel)
  }

  await cancelLogin()

  for (const rel of ['creds.json', 'twofa.pipe']) {
    const p = path.join(tmp, rel)
    assert.equal(await fsp.access(p).then(() => true, () => false), false, rel)
  }
})

test('clearHardBlock and getHardBlock manage the hard-block reason', () => {
  assert.equal(getHardBlock(), null)
})

test('submit2FA emits ready when cached session already exists', async () => {
  await cancelLogin()
  await fsp.mkdir(path.join(tmp, 'data', 'data', 'com.apple.android.music', 'files'), {
    recursive: true,
  })
  await fsp.writeFile(
    path.join(tmp, 'data', 'data', 'com.apple.android.music', 'files', 'marker'),
    'x',
  )
  events.length = 0
  const start = await startWrapperLogin({ email: 'cached@x.com', password: 'pw' })
  assert.equal(start.ok, true)
  await submit2FA('123456')
  const phases = phaseEvents().map((d) => d.phase)
  assert.ok(phases.includes('ready'), `got: ${JSON.stringify(phases)}`)
  await cancelLogin()
})

test('cancelLogin stops the ready poll', async () => {
  await cancelLogin()
  const { cancelLogin: reimportCancel } = await import('../lib/wrapperLogin.mjs')
  await reimportCancel()
})