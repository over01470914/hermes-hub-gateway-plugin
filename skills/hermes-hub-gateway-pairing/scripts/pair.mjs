#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HTTP_TIMEOUT_MS = 15_000
const DEFAULT_INSTALLER_TIMEOUT_MS = 300_000
const DEFAULT_TERMINATE_GRACE_MS = 1_000
const DEFAULT_CLOSE_GRACE_MS = 1_000
const MAX_JSON_BYTES = 1024 * 1024
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024
const MAX_REASON_CHARS = 2_048
const RELEASE_FIELDS = Object.freeze([
  'repositoryUrl',
  'commit',
  'sourceUrl',
  'manifestUrl',
  'installerUrl',
  'installerBytes',
  'installerSha256',
])

export class PairingFailure extends Error {
  constructor(step, message) {
    super(message)
    this.name = 'PairingFailure'
    this.step = step
  }
}

function fail(step, message) {
  throw new PairingFailure(step, sanitizeReason(message))
}

function argsOf(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item !== '--router' && item !== '--request-id') fail(1, `unsupported argument ${item}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(1, `missing value for ${item}`)
    parsed[item.slice(2)] = value.trim()
    index += 1
  }
  return parsed
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function normalizedOrigin(value, step = 2) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(step, 'Router URL is malformed')
  }
  if (url.username || url.password || url.search || url.hash) fail(step, 'Router URL contains forbidden components')
  if (url.pathname !== '/' && url.pathname !== '') fail(step, 'Router URL must be an origin without a path')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    fail(step, 'Router URL must use HTTPS unless it is loopback')
  }
  return url.origin
}

function validateRequestId(value) {
  if (!/^pair_[A-Za-z0-9._-]{1,200}$/.test(value || '')) fail(2, 'pairing request ID is malformed')
  return value
}

function commandResult(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    windowsHide: true,
  })
}

function requireCommand(command, args, label, runner) {
  let result
  try {
    result = runner(command, args)
  } catch (error) {
    fail(1, `${label} could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!result || typeof result !== 'object') fail(1, `${label} returned an invalid process result`)
  if (result.signal) fail(1, `${label} terminated by signal ${result.signal}`)
  if (result.status !== 0) {
    const detail = lastNonEmptyLine(result.stderr) || lastNonEmptyLine(result.stdout) || `${label} exited unsuccessfully`
    fail(1, detail)
  }
  return String(result.stdout || '').trim()
}

function verifyPrerequisites(environment, runner) {
  const nodeVersionOutput = requireCommand(process.execPath, ['--version'], 'Node.js', runner)
  const match = nodeVersionOutput.match(/v?(\d+)(?:\.\d+){0,2}/)
  if (!match || Number(match[1]) < 18) fail(1, 'Node.js 18 or newer is required')

  const hermesCommand = String(environment.HERMES_COMMAND || '').trim() || 'hermes'
  requireCommand(hermesCommand, ['--version'], 'Hermes CLI', runner)
  const configPath = requireCommand(hermesCommand, ['config', 'path'], 'Hermes CLI config path', runner)
  const resolvedConfigPath = lastNonEmptyLine(configPath)
  if (!resolvedConfigPath) fail(1, 'Hermes CLI returned an empty config path')
  return resolve(resolvedConfigPath)
}

function localPairingConfigPath(environment, hermesConfigPath) {
  const hermesHome = String(environment.HERMES_HOME || '').trim()
  return join(hermesHome ? resolve(hermesHome) : dirname(hermesConfigPath), 'hermes-hub', 'pairing.json')
}

async function approvalEnvironment(router, environment, hermesConfigPath) {
  if (String(environment.HERMES_HUB_AGENT_APPROVAL_TOKEN || '').trim()) return environment

  const hostname = new URL(router).hostname.toLowerCase()
  if (!isLoopback(hostname)) fail(4, 'approval credential missing')

  let parsed
  try {
    parsed = JSON.parse(await readFile(localPairingConfigPath(environment, hermesConfigPath), 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      fail(4, 'approval credential missing')
    }
    fail(4, 'local pairing configuration is invalid')
  }
  const approvalToken = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.schemaVersion === 1 && typeof parsed.approvalToken === 'string'
    ? parsed.approvalToken
    : ''
  if (approvalToken.length < 32 || /\s/.test(approvalToken)) {
    fail(4, 'local pairing configuration is invalid')
  }
  return { ...environment, HERMES_HUB_AGENT_APPROVAL_TOKEN: approvalToken }
}

function abortAfter(milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), milliseconds)
  timer.unref?.()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function fetchBody(url, fetchImpl, timeoutMs, step, maximumBytes) {
  const timeout = abortAfter(timeoutMs)
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: timeout.signal })
    if (response.status >= 300 && response.status < 400) fail(step, `redirect response ${response.status} is not allowed`)
    if (response.status !== 200) fail(step, `HTTP ${response.status} from ${new URL(url).pathname}`)
    return await readBoundedBody(response, maximumBytes, step)
  } catch (error) {
    if (error instanceof PairingFailure) throw error
    const message = error instanceof Error ? error.message : String(error)
    fail(step, message.includes('abort') || message.includes('timed out') ? 'request timed out' : message)
  } finally {
    timeout.clear()
  }
}

async function readBoundedBody(response, maximumBytes, step) {
  if (!response.body) fail(step, 'HTTP response body is missing')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) fail(step, 'HTTP response exceeds the allowed size')
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function fetchJson(url, fetchImpl, timeoutMs, step) {
  const body = await fetchBody(url, fetchImpl, timeoutMs, step, MAX_JSON_BYTES)
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(step, 'JSON response must be an object')
    return parsed
  } catch (error) {
    if (error instanceof PairingFailure) throw error
    fail(step, 'HTTP response contains malformed JSON')
  }
}

function validateReleasePolicy(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) fail(2, 'local release policy is malformed')
  for (const field of RELEASE_FIELDS) {
    if (!(field in release)) fail(2, `local release policy is missing ${field}`)
  }
  if (!/^https:\/\/[^\s]+$/.test(release.repositoryUrl)) fail(2, 'local release repository URL is invalid')
  if (!/^[0-9a-f]{40}$/.test(release.commit)) fail(2, 'local release commit is invalid')
  for (const field of ['sourceUrl', 'manifestUrl', 'installerUrl']) {
    let url
    try {
      url = new URL(release[field])
    } catch {
      fail(2, `local release ${field} is invalid`)
    }
    if (url.username || url.password || url.search || url.hash) fail(2, `local release ${field} contains forbidden components`)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
      fail(2, `local release ${field} must use HTTPS unless it is loopback`)
    }
  }
  if (!Number.isInteger(release.installerBytes) || release.installerBytes <= 0 || release.installerBytes > 2 * 1024 * 1024) {
    fail(2, 'local release installerBytes is invalid')
  }
  if (!/^[0-9a-f]{64}$/.test(release.installerSha256)) fail(2, 'local release installerSha256 is invalid')
  return release
}

function requireExactRouterRelease(health, expected) {
  const actual = health?.gatewayPlugin?.release
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) fail(2, 'Router health is missing gatewayPlugin.release')
  for (const field of RELEASE_FIELDS) {
    if (actual[field] !== expected[field]) fail(2, `Router release mismatch for ${field}`)
  }
}

function requirePendingPairing(pairing, requestId, nowSeconds) {
  if (pairing.requestId !== requestId) fail(2, 'Router pairing request ID mismatch')
  if (pairing.status !== 'pending') fail(2, `Router pairing status is ${String(pairing.status || 'missing')}`)
  if (!Number.isInteger(pairing.expiresAt)) fail(2, 'Router pairing expiresAt is malformed')
  if (pairing.expiresAt <= nowSeconds) fail(2, 'Router pairing request has expired')
}

async function downloadInstaller(release, fetchImpl, timeoutMs, temporaryRoot) {
  let directory
  try {
    directory = await mkdtemp(join(temporaryRoot, 'hermes-hub-gateway-pairing-'))
  } catch (error) {
    fail(3, error instanceof Error ? error.message : String(error))
  }
  const installerPath = join(directory, 'install.mjs')
  try {
    const body = await fetchBody(release.installerUrl, fetchImpl, timeoutMs, 3, release.installerBytes)
    if (body.length !== release.installerBytes) fail(3, `installer byte count mismatch: expected ${release.installerBytes}, received ${body.length}`)
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== release.installerSha256) fail(3, 'installer SHA-256 mismatch')
    await writeFile(installerPath, body, { flag: 'wx', mode: 0o600 })
    return { directory, installerPath }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    if (error instanceof PairingFailure) throw error
    fail(3, error instanceof Error ? error.message : String(error))
  }
}

export function collectChild(command, args, environment, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALLER_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? MAX_CHILD_OUTPUT_BYTES
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS
  const spawnImpl = options.spawnImpl || spawn

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(command, args, {
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow = false
    let timedOut = false
    let settled = false
    let terminationStarted = false
    let exitStatus = null
    let exitSignal = null
    let forceTimer
    let closeTimer

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    const clearTimers = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(forceTimer)
      clearTimeout(closeTimer)
    }

    const result = (status, signal) => ({
      status,
      signal,
      overflow,
      timedOut,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })

    const settle = (status, signal) => {
      if (settled) return
      settled = true
      clearTimers()
      resolve(result(status, signal))
    }

    const forceSettle = () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref?.()
      settle(exitStatus, exitSignal || 'SIGKILL')
    }

    function terminate() {
      if (terminationStarted || settled) return
      terminationStarted = true
      try {
        child.kill('SIGTERM')
      } catch {
        // Continue to the forced termination deadline.
      }
      if (settled) return
      forceTimer = setTimeout(() => {
        if (settled) return
        try {
          child.kill('SIGKILL')
        } catch {
          // The bounded close deadline still settles the wrapper.
        }
        if (settled) return
        closeTimer = setTimeout(forceSettle, closeGraceMs)
      }, terminateGraceMs)
    }

    const append = (target, chunk, stream) => {
      if (overflow) return
      const bytes = Buffer.from(chunk)
      if (stream === 'stdout') stdoutBytes += bytes.length
      else stderrBytes += bytes.length
      if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
        overflow = true
        terminate()
        return
      }
      target.push(bytes)
    }

    child.stdout?.on('data', chunk => append(stdout, chunk, 'stdout'))
    child.stderr?.on('data', chunk => append(stderr, chunk, 'stderr'))
    child.on('error', error => {
      if (settled || terminationStarted) return
      settled = true
      clearTimers()
      reject(error)
    })
    child.once('exit', (status, signal) => {
      exitStatus = status
      exitSignal = signal
    })
    child.once('close', (status, signal) => settle(status, signal))
  })
}

function lastNonEmptyLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .pop() || ''
}

function redactExactSecrets(value, secrets) {
  let redacted = String(value || '')
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(String(secret)).join('[REDACTED]')
  }
  return redacted
}

export function sanitizeReason(value, secrets = []) {
  const reason = redactExactSecrets(value, secrets)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|secret|credential|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/"(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/|(?:router|v1|api)(?:\/|$)))[^"]+"/g, '[HOST_PATH]')
    .replace(/'(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/|(?:router|v1|api)(?:\/|$)))[^']+'/g, '[HOST_PATH]')
    .replace(/\bfile:\/\/.*$/gi, '[HOST_PATH]')
    .replace(/(^|[\s(=])\\\\.*$/g, '$1[HOST_PATH]')
    .replace(/\b[A-Za-z]:[\\/].*$/g, '[HOST_PATH]')
    .replace(/(^|[\s(=])\/(?!\/|(?:router|v1|api)(?:\/|$)).*$/g, '$1[HOST_PATH]')
    .replace(/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
  const bounded = reason || 'unspecified failure'
  return bounded.length > MAX_REASON_CHARS
    ? `${bounded.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`
    : bounded
}

async function invokeInstaller(installerPath, router, requestId, release, environment, runtime) {
  const approvalToken = String(environment.HERMES_HUB_AGENT_APPROVAL_TOKEN || '').trim()
  if (!approvalToken) fail(4, 'approval credential missing')

  let result
  try {
    result = await (runtime.childRunner || collectChild)(
      process.execPath,
      [installerPath, '--router', router, '--request-id', requestId, '--source-base', release.sourceUrl],
      environment,
      {
        timeoutMs: runtime.installerTimeoutMs || DEFAULT_INSTALLER_TIMEOUT_MS,
        maxOutputBytes: runtime.maxChildOutputBytes || MAX_CHILD_OUTPUT_BYTES,
      },
    )
  } catch (error) {
    fail(4, sanitizeReason(error instanceof Error ? error.message : String(error), [approvalToken]))
  }

  if (result.timedOut) fail(4, 'installer timed out')
  if (result.overflow) fail(4, 'installer output exceeded the allowed size')
  if (result.signal) fail(4, `installer terminated by signal ${result.signal}`)
  if (result.status !== 0) {
    const stderr = redactExactSecrets(result.stderr, [approvalToken])
    const stdout = redactExactSecrets(result.stdout, [approvalToken])
    const official = lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout) || `installer exited with status ${String(result.status)}`
    fail(4, sanitizeReason(official))
  }

  const output = String(result.stdout || '')
  const code = /^([0-9]{8})(?:\r?\n)?$/.exec(output)
  if (!code) fail(4, 'installer stdout was not exactly one pairing code line')
  return code[1]
}

export async function runPairing(input, runtime = {}) {
  const environment = runtime.environment || process.env
  const commandRunner = runtime.commandRunner || commandResult

  const hermesConfigPath = verifyPrerequisites(environment, commandRunner)

  const fetchImpl = runtime.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') fail(2, 'Node.js built-in fetch is unavailable')
  const router = normalizedOrigin(input.router)
  const requestId = validateRequestId(input.requestId)
  const release = validateReleasePolicy(input.release)
  const installerEnvironment = await approvalEnvironment(router, environment, hermesConfigPath)

  const timeoutMs = runtime.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS
  const health = await fetchJson(`${router}/router/health`, fetchImpl, timeoutMs, 2)
  requireExactRouterRelease(health, release)
  const pairing = await fetchJson(
    `${router}/router/pairing/${encodeURIComponent(requestId)}`,
    fetchImpl,
    timeoutMs,
    2,
  )
  requirePendingPairing(pairing, requestId, Math.floor(Date.now() / 1000))

  const downloaded = await downloadInstaller(release, fetchImpl, timeoutMs, runtime.temporaryRoot || tmpdir())
  try {
    return await invokeInstaller(downloaded.installerPath, router, requestId, release, installerEnvironment, runtime)
  } finally {
    await rm(downloaded.directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function loadReleasePolicy() {
  const path = fileURLToPath(new URL('../references/release.json', import.meta.url))
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    fail(2, 'local release policy could not be loaded')
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = argsOf(argv)
  if (!args.router) fail(1, 'missing --router')
  if (!args['request-id']) fail(1, 'missing --request-id')
  return runPairing({
    router: args.router,
    requestId: args['request-id'],
    release: await loadReleasePolicy(),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(code => process.stdout.write(`${code}\n`))
    .catch(error => {
      const step = error instanceof PairingFailure ? error.step : 4
      const reason = error instanceof PairingFailure ? error.message : sanitizeReason(error instanceof Error ? error.message : String(error))
      process.stdout.write(`FAILED step ${step}: ${reason}\n`)
      process.exitCode = 1
    })
}
