#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  approvePairing,
  defaultGatewayPackageSourceBase,
  InstallerCrashSimulation,
  installPlugin,
  loadOrCreateHostIdentity,
  main,
  normalizePackageSourceBase,
  normalizeRouterUrl,
  packageRequestHeaders,
  recoverInstallerTransaction,
  resolvePackageFileUrl,
  waitForGatewayOnline,
} from './install.mjs'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'hermes-hub-gateway-install-'))
const packageRoot = dirname(fileURLToPath(import.meta.url))
const packageFiles = Object.freeze([
  '__init__.py',
  'adapter.py',
  'protocol.py',
  'plugin.yaml',
  'install.mjs',
  'package-manifest.json',
])
const packagePayloadFiles = packageFiles.filter(name => name !== 'package-manifest.json')
const packageBytes = new Map(packageFiles.map(name => [name, readFileSync(join(packageRoot, name))]))
const packageManifest = JSON.parse(packageBytes.get('package-manifest.json').toString('utf8'))
let server
let redirectServer
let redirectSink
let packageServer
let packageRedirectSink

function token(character) {
  return Buffer.alloc(48, character).toString('base64url')
}

function installerStatePath(identityPath) {
  return join(dirname(identityPath), `.${basename(identityPath)}.install-state`)
}

function upsertEnv(path, key, value) {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
  const next = []
  let replaced = false
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith(`${key}=`)) {
      if (!replaced) next.push(`${key}=${value}`)
      replaced = true
    } else {
      next.push(line)
    }
  }
  if (!replaced) next.push(`${key}=${value}`)
  writeFileSync(path, `${next.join('\n')}\n`, 'utf8')
}

function createFixture(label) {
  const home = join(temporaryRoot, label)
  const configPath = join(home, 'config.yaml')
  const envPath = join(home, '.env')
  const target = join(home, 'plugins', 'hermes-hub-gateway')
  const identityPath = join(home, 'platforms', 'hermes-hub-gateway', 'identity.json')
  mkdirSync(target, { recursive: true })
  writeFileSync(configPath, `fixture: ${label}\n`, 'utf8')
  writeFileSync(envPath, [
    'API_SERVER_KEY=old-api-key',
    `HERMES_HUB_AGENT_ID=agent_${label}`,
    `HERMES_HUB_GATEWAY_ID=gw_${label}_old`,
    `HERMES_HUB_GATEWAY_TOKEN=${token('a')}`,
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(target, 'old-plugin.txt'), `old plugin ${label}\n`, 'utf8')
  const oldIdentity = loadOrCreateHostIdentity(identityPath, {
    seed: {
      hermesAgentId: `agent_${label}`,
      gatewayId: `gw_${label}_old`,
      gatewayToken: token('a'),
    },
  })
  const original = {
    config: readFileSync(configPath),
    env: readFileSync(envPath),
    identity: readFileSync(identityPath),
    pluginEntries: readdirSync(target).sort(),
    pluginMarker: readFileSync(join(target, 'old-plugin.txt')),
  }
  return {
    label,
    home,
    configPath,
    envPath,
    target,
    identityPath,
    oldIdentity,
    original,
    restartAttempts: 0,
    successfulRestarts: 0,
    failConfigKey: '',
    failNextRestart: false,
  }
}

function fakeHermesRunner(fixture) {
  return (_command, args) => {
    if (args[0] === 'config' && args[1] === 'path') {
      return { status: 0, stdout: `${fixture.configPath}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === 'env-path') {
      return { status: 0, stdout: `${fixture.envPath}\n`, stderr: '' }
    }
    if (args[0] === 'config' && args[1] === 'set') {
      if (args[2] === fixture.failConfigKey) return { status: 1, stdout: '', stderr: 'rejected' }
      upsertEnv(fixture.envPath, args[2], args[3])
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'plugins' && args[1] === 'list') {
      const discovered = existsSync(join(fixture.target, 'plugin.yaml'))
        ? [{ key: 'hermes-hub-gateway' }]
        : []
      return { status: 0, stdout: JSON.stringify(discovered), stderr: '' }
    }
    if (args[0] === 'plugins' && args[1] === 'enable') {
      writeFileSync(fixture.configPath, 'plugins:\n  hermes-hub-gateway: enabled\n', 'utf8')
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'gateway' && args[1] === 'restart') {
      fixture.restartAttempts += 1
      if (fixture.failNextRestart) {
        fixture.failNextRestart = false
        return { status: 1, stdout: '', stderr: 'restart failed' }
      }
      fixture.successfulRestarts += 1
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' }
  }
}

function routerFetch(options = {}) {
  let approvedIdentity = null
  let approvalCalls = 0
  let gatewayCalls = 0
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url)
    if (request.method === 'POST' && parsed.pathname === '/router/pairing/approve') {
      approvalCalls += 1
      if (options.approvalStatus && options.approvalStatus !== 200) {
        return new Response('{}', {
          status: options.approvalStatus,
          headers: { 'content-type': 'application/json' },
        })
      }
      assert.equal(request.headers['x-hermes-hub-agent-approval'], 'approval-header-value')
      approvedIdentity = JSON.parse(request.body)
      return new Response(JSON.stringify({
        requestId: approvedIdentity.requestId,
        randomCode: '12345678',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        hermesAgentId: approvedIdentity.hermesAgentId,
        gatewayId: approvedIdentity.gatewayId,
        gatewayToken: approvedIdentity.gatewayToken,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (request.method === 'GET' && parsed.pathname.startsWith('/router/hermes-hub-gateways/')) {
      gatewayCalls += 1
      const wrong = options.gatewayMode === 'wrong'
      const credentialState = options.gatewayMode === 'unclaimed' && gatewayCalls > 1
        ? 'revoked'
        : (gatewayCalls > 1 ? 'active' : 'provisional')
      return new Response(JSON.stringify({
        online: true,
        hermesAgentId: wrong ? 'agent_wrong_gateway' : approvedIdentity?.hermesAgentId,
        gatewayId: wrong ? 'gw_wrong_gateway' : approvedIdentity?.gatewayId,
        connectedAt: Math.floor(Date.now() / 1000) + 1,
        protocols: ['hermes-hub-gateway-rpc/v1'],
        gatewayCredentialState: credentialState,
        routable: credentialState === 'active',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  return {
    fetchImpl,
    get approvalCalls() { return approvalCalls },
    get gatewayCalls() { return gatewayCalls },
    get approvedIdentity() { return approvedIdentity },
  }
}

function installerArgs(fixture) {
  return [
    '--router', 'http://127.0.0.1:4320',
    '--request-id', `pair_${fixture.label}`,
    '--hermes-home', fixture.home,
    '--rotate-gateway',
    '--heartbeat-timeout-seconds', '1',
    '--quiet',
  ]
}

function runtime(fixture, router, extra = {}) {
  return {
    environment: { HERMES_HUB_AGENT_APPROVAL_TOKEN: 'approval-header-value' },
    commandRunner: fakeHermesRunner(fixture),
    fetchImpl: router.fetchImpl,
    writeCode: extra.writeCode || (() => undefined),
    onCheckpoint: extra.onCheckpoint,
    startFinalizer: extra.startFinalizer || (() => undefined),
  }
}

async function finalize(fixture, router, extra = {}) {
  return recoverInstallerTransaction(
    fixture.identityPath,
    fixture.target,
    'fake-hermes',
    {
      approvalToken: 'approval-header-value',
      commandRunner: fakeHermesRunner(fixture),
      fetchImpl: router.fetchImpl,
      waitForPromotion: true,
      pollMs: 20,
      onCheckpoint: extra.onCheckpoint,
    },
  )
}

function assertRolledBack(fixture) {
  assert.deepEqual(readFileSync(fixture.configPath), fixture.original.config, 'config must roll back exactly')
  assert.deepEqual(readFileSync(fixture.envPath), fixture.original.env, 'env must roll back exactly')
  assert.deepEqual(readFileSync(fixture.identityPath), fixture.original.identity, 'formal identity must remain unchanged')
  assert.deepEqual(readdirSync(fixture.target).sort(), fixture.original.pluginEntries, 'old plugin tree must be restored')
  assert.deepEqual(readFileSync(join(fixture.target, 'old-plugin.txt')), fixture.original.pluginMarker)
  assert.equal(existsSync(installerStatePath(fixture.identityPath)), false, 'transaction state must be cleared')
}

function assertWindowsPrivate(path) {
  const result = spawnSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `could not inspect private ACL for ${basename(path)}`)
  const output = String(result.stdout || '')
  assert.doesNotMatch(output, /\(I\)/, `${basename(path)} retained inherited ACL entries`)
  assert.doesNotMatch(
    output,
    /Everyone|Authenticated Users|BUILTIN\\Users|CodexSandboxUsers/i,
    `${basename(path)} retained a broad explicit ACL entry`,
  )
}

async function expectCheckpointRollback(label, checkpointName, expectedRestarts) {
  const fixture = createFixture(label)
  const router = routerFetch()
  await assert.rejects(
    main(installerArgs(fixture), runtime(fixture, router, {
      onCheckpoint(context) {
        if (context.name === checkpointName) throw new Error(`failure at ${checkpointName}`)
      },
    })),
    new RegExp(`failure at ${checkpointName}`),
  )
  assertRolledBack(fixture)
  assert.equal(fixture.successfulRestarts, expectedRestarts)
}

async function listen(serverInstance) {
  await new Promise((resolvePromise, reject) => {
    serverInstance.once('error', reject)
    serverInstance.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = serverInstance.address()
  assert.ok(address && typeof address === 'object')
  return normalizeRouterUrl(`http://127.0.0.1:${address.port}/`)
}

function scenarioManifest(scenario) {
  const manifest = JSON.parse(JSON.stringify(packageManifest))
  if (scenario === 'oversized_file') {
    manifest.files.find(file => file.name === 'adapter.py').bytes = 2 * 1024 * 1024 + 1
  }
  if (scenario === 'oversized_package') {
    for (const file of manifest.files) file.bytes = 1024 * 1024
  }
  if (scenario === 'invalid_allowlist') {
    manifest.files.push({ name: 'README.md', bytes: 1, sha256: '0'.repeat(64) })
  }
  return manifest
}

function packageScenarioBytes(scenario, name) {
  if (name === 'package-manifest.json') {
    if (scenario === 'invalid_json') return Buffer.from('{', 'utf8')
    if (['oversized_file', 'oversized_package', 'invalid_allowlist'].includes(scenario)) {
      return Buffer.from(`${JSON.stringify(scenarioManifest(scenario))}\n`, 'utf8')
    }
    return packageBytes.get(name)
  }
  const original = packageBytes.get(name)
  if (!original) return null
  if (scenario === 'tampered_hash' && name === 'adapter.py') {
    const tampered = Buffer.from(original)
    tampered[0] ^= 0xff
    return tampered
  }
  if (scenario === 'oversized_content' && name === 'adapter.py') {
    return Buffer.concat([original, Buffer.from([0])])
  }
  return original
}

async function runNode(args) {
  const child = spawn(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  const status = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  })
  return {
    status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

function existingTarget(label) {
  const target = join(temporaryRoot, label)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'old-plugin.txt'), 'old plugin remains\n', 'utf8')
  return target
}

async function expectPackageFailure(sourceRoot, scenario, pattern) {
  const target = existingTarget(`package-failure-${scenario}`)
  await assert.rejects(
    installPlugin(target, { sourceBase: `${sourceRoot}/${scenario}/` }),
    pattern,
  )
  assert.deepEqual(readdirSync(target), ['old-plugin.txt'])
}

try {
  let packageRedirectSinkReached = false
  packageRedirectSink = createServer((_request, response) => {
    packageRedirectSinkReached = true
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end('redirected')
  })
  const packageRedirectSinkUrl = await listen(packageRedirectSink)
  packageServer = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
    const segments = pathname.split('/').filter(Boolean)
    const scenario = segments[0]
    const name = segments[1]
    const extra = segments.slice(2)
    if (!scenario || !name || extra.length > 0 || !packageFiles.includes(name)) {
      response.writeHead(404, { 'content-length': '0' })
      response.end()
      return
    }
    if (scenario === 'redirect' && name === 'adapter.py') {
      response.writeHead(302, { location: `${packageRedirectSinkUrl}/redirected-package-file` })
      response.end()
      return
    }
    if (scenario === 'missing_file' && name === 'protocol.py') {
      response.writeHead(404, { 'content-length': '0' })
      response.end()
      return
    }
    const body = packageScenarioBytes(scenario, name)
    if (!body) {
      response.writeHead(404, { 'content-length': '0' })
      response.end()
      return
    }
    const encodedBody = scenario === 'compressed' ? gzipSync(body) : body
    response.writeHead(200, {
      ...(scenario === 'compressed' ? { 'content-encoding': 'gzip' } : {}),
      'content-length': String(encodedBody.length),
      'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    })
    response.end(encodedBody)
  })
  const packageSourceRoot = await listen(packageServer)

  const target = join(temporaryRoot, 'copy-only-plugin')
  await installPlugin(target)
  assert.deepEqual(readdirSync(target).sort(), [...packageFiles].sort(), 'installed package must contain exactly the allowlist')
  assert.deepEqual(
    packageManifest.files.map(file => file.name).sort(),
    [...packagePayloadFiles].sort(),
    'manifest must cover every payload and only the payload allowlist',
  )
  assert.match(readFileSync(join(target, 'plugin.yaml'), 'utf8'), /name:\s*hermes-hub-gateway/)
  assert.throws(() => normalizeRouterUrl('http://192.0.2.10:4320'), /must use HTTPS/)
  assert.equal(normalizeRouterUrl('https://router.example/'), 'https://router.example')
  assert.throws(() => normalizePackageSourceBase('http://192.0.2.10/package/'), /must use HTTPS/)
  assert.throws(() => normalizePackageSourceBase('https://user@example.test/package/'), /must not contain credentials/)
  assert.throws(() => normalizePackageSourceBase('https://example.test/package/?channel=dev'), /query/)
  assert.equal(
    defaultGatewayPackageSourceBase,
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/',
  )
  assert.equal(
    resolvePackageFileUrl(defaultGatewayPackageSourceBase, 'package-manifest.json'),
    'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/package-manifest.json',
  )
  assert.equal(
    resolvePackageFileUrl(
      'https://cnb.cool/example/repository/-/tree/main/gateway-package',
      'package-manifest.json',
    ),
    'https://cnb.cool/example/repository/-/git/raw/main/gateway-package/package-manifest.json',
    'an explicit CNB mirror must still resolve its browsable tree URL to raw files',
  )
  assert.equal(
    resolvePackageFileUrl('https://mirror.example/package/', 'install.mjs'),
    'https://mirror.example/package/install.mjs',
  )
  const testCnbToken = 'read-only-test-token'
  assert.equal(
    packageRequestHeaders(
      'https://cnb.cool/example/repository/-/git/raw/main/package-manifest.json',
      'package-manifest.json',
      { CNB_TOKEN: testCnbToken },
    ).authorization,
    `Basic ${Buffer.from(`cnb:${testCnbToken}`).toString('base64')}`,
  )
  assert.equal(
    packageRequestHeaders(
      'https://mirror.example/package/package-manifest.json',
      'package-manifest.json',
      { CNB_TOKEN: testCnbToken },
    ).authorization,
    undefined,
    'CNB credentials must never be sent to a mirror host',
  )

  const bootstrapDir = join(temporaryRoot, 'single-file-bootstrap')
  mkdirSync(bootstrapDir, { recursive: true })
  const bootstrapInstaller = join(bootstrapDir, 'install.mjs')
  copyFileSync(join(packageRoot, 'install.mjs'), bootstrapInstaller)
  const bootstrapTarget = join(temporaryRoot, 'single-file-installed-plugin')
  const bootstrapResult = await runNode([
    bootstrapInstaller,
    '--copy-only',
    '--target', bootstrapTarget,
    '--router', `${packageSourceRoot}/router-dev`,
    '--source-base', `${packageSourceRoot}/valid/`,
  ])
  assert.equal(bootstrapResult.status, 0, bootstrapResult.stderr)
  assert.deepEqual(
    readdirSync(bootstrapTarget).sort(),
    [...packageFiles].sort(),
    'single-file bootstrap must install the exact public package',
  )

  await expectPackageFailure(packageSourceRoot, 'tampered_hash', /failed SHA-256 verification/)
  assert.ok(
    gzipSync(packageBytes.get('__init__.py')).length > packageBytes.get('__init__.py').length,
    'compressed fixture must reproduce transfer bytes larger than decoded expected bytes',
  )
  const compressedTarget = join(temporaryRoot, 'compressed-package')
  await installPlugin(compressedTarget, { sourceBase: `${packageSourceRoot}/compressed/` })
  assert.deepEqual(
    readdirSync(compressedTarget).sort(),
    [...packageFiles].sort(),
    'compressed package responses must be checked by decoded size and final hash',
  )
  await expectPackageFailure(packageSourceRoot, 'redirect', /redirects are not allowed/)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  assert.equal(packageRedirectSinkReached, false, 'package redirect target must never be contacted')
  await expectPackageFailure(packageSourceRoot, 'oversized_content', /is too large/)
  await expectPackageFailure(packageSourceRoot, 'oversized_file', /invalid or oversized/)
  await expectPackageFailure(packageSourceRoot, 'oversized_package', /total size limit/)
  await expectPackageFailure(packageSourceRoot, 'missing_file', /could not be downloaded \(404\)/)
  await expectPackageFailure(packageSourceRoot, 'invalid_json', /contains invalid JSON/)
  await expectPackageFailure(packageSourceRoot, 'invalid_allowlist', /allowlist is invalid/)

  const mismatchedBootstrap = join(bootstrapDir, 'tampered-install.mjs')
  writeFileSync(
    mismatchedBootstrap,
    Buffer.concat([readFileSync(join(packageRoot, 'install.mjs')), Buffer.from('\n', 'utf8')]),
  )
  const mismatchTarget = existingTarget('bootstrap-hash-mismatch-target')
  const mismatchResult = await runNode([
    mismatchedBootstrap,
    '--copy-only',
    '--target', mismatchTarget,
    '--source-base', `${packageSourceRoot}/valid/`,
  ])
  assert.notEqual(mismatchResult.status, 0)
  assert.match(mismatchResult.stderr, /executing Gateway installer does not match the package manifest/)
  assert.deepEqual(readdirSync(mismatchTarget), ['old-plugin.txt'])

  const identityPath = join(temporaryRoot, 'private', 'gateway-host.json')
  const first = loadOrCreateHostIdentity(identityPath)
  const reused = loadOrCreateHostIdentity(identityPath)
  assert.deepEqual(reused, first, 'host identity must be stable by default')
  const rotated = loadOrCreateHostIdentity(identityPath, { rotateGateway: true })
  assert.equal(rotated.hermesAgentId, first.hermesAgentId, 'Hermes Agent id must survive Gateway rotation')
  assert.notEqual(rotated.gatewayId, first.gatewayId)
  assert.notEqual(rotated.gatewayToken, first.gatewayToken)
  assert.equal(readFileSync(identityPath, 'utf8').includes(rotated.gatewayToken), true)
  if (process.platform !== 'win32') assert.equal(statSync(identityPath).mode & 0o777, 0o600)

  let gatewayPollCount = 0
  server = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/router/pairing/approve') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.requestId === 'pair_large_response') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }))
        return
      }
      assert.equal(request.headers['x-hermes-hub-agent-approval'], 'approval-header-value')
      assert.deepEqual(body, {
        requestId: 'pair_smoke',
        hermesAgentId: rotated.hermesAgentId,
        gatewayId: rotated.gatewayId,
        gatewayToken: rotated.gatewayToken,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        requestId: body.requestId,
        randomCode: '12345678',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        hermesAgentId: body.hermesAgentId,
        gatewayId: body.gatewayId,
        gatewayToken: body.gatewayToken,
      }))
      return
    }
    if (request.method === 'GET' && request.url === `/router/hermes-hub-gateways/${encodeURIComponent(rotated.gatewayId)}`) {
      gatewayPollCount += 1
      assert.equal(request.headers['x-hermes-hub-agent-approval'], 'approval-header-value')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        online: gatewayPollCount > 1,
        hermesAgentId: rotated.hermesAgentId,
        gatewayId: rotated.gatewayId,
        connectedAt: gatewayPollCount === 2 ? 50 : 200,
        protocols: gatewayPollCount === 3 ? ['wrong-protocol/v1'] : ['hermes-hub-gateway-rpc/v1'],
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  const routerUrl = await listen(server)
  const approval = await approvePairing(routerUrl, 'pair_smoke', rotated, {
    approvalToken: 'approval-header-value',
  })
  assert.equal(approval.randomCode, '12345678')
  assert.ok(approval.expiresAtMs > Date.now())
  assert.equal(readFileSync(identityPath, 'utf8').includes(approval.randomCode), false, 'pairing code must not be persisted')
  const gateway = await waitForGatewayOnline(routerUrl, rotated.hermesAgentId, rotated.gatewayId, {
    timeoutMs: 2_000,
    pollMs: 20,
    approvalToken: 'approval-header-value',
    notBefore: 100,
  })
  assert.equal(gateway.online, true)
  assert.ok(gatewayPollCount > 3, 'Gateway wait must reject offline, stale, and wrong-protocol responses')

  await assert.rejects(
    approvePairing(routerUrl, 'pair_large_response', rotated, {
      approvalToken: 'approval-header-value',
    }),
    /response is too large/,
  )

  let redirectSinkReached = false
  redirectSink = createServer(async (request, response) => {
    redirectSinkReached = true
    for await (const _chunk of request) {
      // Drain without retaining possible credentials.
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{}')
  })
  const sinkUrl = await listen(redirectSink)
  redirectServer = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain without retaining possible credentials.
    }
    response.writeHead(307, { location: `${sinkUrl}/credential-sink` })
    response.end()
  })
  const redirectUrl = await listen(redirectServer)
  await assert.rejects(
    approvePairing(redirectUrl, 'pair_redirect', rotated, {
      approvalToken: 'approval-header-value',
    }),
    /redirects are not allowed/,
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  assert.equal(redirectSinkReached, false, 'Router redirect must not receive approval material')

  const success = createFixture('success')
  const successRouter = routerFetch()
  const emittedCodes = []
  const foregroundOrder = []
  await main(installerArgs(success), runtime(success, successRouter, {
    startFinalizer: () => foregroundOrder.push('finalizer_scheduled'),
    writeCode: code => {
      emittedCodes.push(code)
      foregroundOrder.push('code_emitted')
    },
    onCheckpoint(context) {
      if (context.name === 'gateway_verified') {
        assert.deepEqual(
          readFileSync(success.identityPath),
          success.original.identity,
          'formal identity must remain old until exact candidate verification completes',
        )
      }
    },
  }))
  assert.deepEqual(readFileSync(success.identityPath), success.original.identity)
  assert.equal(existsSync(installerStatePath(success.identityPath)), true)
  assert.deepEqual(emittedCodes, ['12345678'])
  assert.deepEqual(foregroundOrder, ['finalizer_scheduled', 'code_emitted'])
  assert.deepEqual(await finalize(success, successRouter), { recovered: true, action: 'finalized' })
  const committedIdentity = JSON.parse(readFileSync(success.identityPath, 'utf8'))
  assert.equal(committedIdentity.hermesAgentId, success.oldIdentity.hermesAgentId)
  assert.notEqual(committedIdentity.gatewayId, success.oldIdentity.gatewayId)
  assert.notEqual(committedIdentity.gatewayToken, success.oldIdentity.gatewayToken)
  assert.notEqual(committedIdentity.installerCommitId, success.oldIdentity.installerCommitId)
  assert.equal(existsSync(join(success.target, 'plugin.yaml')), true)
  assert.equal(existsSync(join(success.target, 'old-plugin.txt')), false)
  assert.match(readFileSync(success.envPath, 'utf8'), new RegExp(`HERMES_HUB_GATEWAY_ID=${committedIdentity.gatewayId}`))
  assert.equal(success.successfulRestarts, 1)
  assert.equal(existsSync(installerStatePath(success.identityPath)), false)

  const concurrent = createFixture('concurrent')
  const concurrentRouter = routerFetch()
  let concurrentRejected = false
  await main(installerArgs(concurrent), runtime(concurrent, concurrentRouter, {
    async onCheckpoint(context) {
      if (context.name !== 'prepared' || concurrentRejected) return
      await assert.rejects(
        main(installerArgs(concurrent), runtime(concurrent, concurrentRouter)),
        /installer is already running for this identity/,
      )
      concurrentRejected = true
    },
  }))
  assert.equal(concurrentRejected, true)
  assert.deepEqual(await finalize(concurrent, concurrentRouter), { recovered: true, action: 'finalized' })
  assert.equal(existsSync(installerStatePath(concurrent.identityPath)), false)

  const approvalFailure = createFixture('approval_failure')
  const rejectedRouter = routerFetch({ approvalStatus: 403 })
  await assert.rejects(
    main(installerArgs(approvalFailure), runtime(approvalFailure, rejectedRouter)),
    /pairing approval failed \(403\)/,
  )
  assertRolledBack(approvalFailure)
  assert.equal(approvalFailure.restartAttempts, 0, 'pre-mutation approval failure must not restart Hermes')

  const missingApproval = createFixture('missing_approval')
  const missingApprovalRouter = routerFetch()
  await assert.rejects(
    main(installerArgs(missingApproval), {
      ...runtime(missingApproval, missingApprovalRouter),
      environment: { HERMES_HUB_AGENT_APPROVAL_TOKEN: '   ' },
    }),
    /approval credential missing/,
  )
  assert.equal(missingApprovalRouter.approvalCalls, 0, 'missing approval credential must stop before Router approval')
  assert.equal(missingApproval.restartAttempts, 0, 'missing approval credential must stop before Hermes restart')
  assertRolledBack(missingApproval)

  await expectCheckpointRollback('stage_failure', 'plugin_staged', 1)
  await expectCheckpointRollback('swap_failure', 'plugin_displaced', 1)
  await expectCheckpointRollback('configured_failure', 'configured', 1)
  await expectCheckpointRollback('verified_failure', 'gateway_verified', 2)

  const partialConfig = createFixture('partial_config')
  partialConfig.failConfigKey = 'HERMES_HUB_GATEWAY_ID'
  await assert.rejects(
    main(installerArgs(partialConfig), runtime(partialConfig, routerFetch())),
    /rejected configuration key HERMES_HUB_GATEWAY_ID/,
  )
  assertRolledBack(partialConfig)
  assert.equal(partialConfig.successfulRestarts, 1)

  const restartFailure = createFixture('restart_failure')
  restartFailure.failNextRestart = true
  await assert.rejects(
    main(installerArgs(restartFailure), runtime(restartFailure, routerFetch())),
    /Hermes command failed: gateway restart/,
  )
  assertRolledBack(restartFailure)
  assert.equal(restartFailure.restartAttempts, 2, 'rollback must restart the restored old runtime')
  assert.equal(restartFailure.successfulRestarts, 1)

  const wrongGateway = createFixture('wrong_gateway')
  const wrongGatewayRouter = routerFetch({ gatewayMode: 'wrong' })
  await assert.rejects(
    main(installerArgs(wrongGateway), runtime(wrongGateway, wrongGatewayRouter)),
    /did not confirm this exact Hermes Hub Gateway connection online/,
  )
  assert.ok(wrongGatewayRouter.gatewayCalls >= 1)
  assertRolledBack(wrongGateway)
  assert.equal(wrongGateway.successfulRestarts, 2)

  const unclaimed = createFixture('unclaimed')
  const unclaimedRouter = routerFetch({ gatewayMode: 'unclaimed' })
  const unclaimedCodes = []
  await main(installerArgs(unclaimed), runtime(unclaimed, unclaimedRouter, {
    writeCode: code => unclaimedCodes.push(code),
  }))
  assert.deepEqual(unclaimedCodes, ['12345678'])
  assert.deepEqual(readFileSync(unclaimed.identityPath), unclaimed.original.identity)
  assert.deepEqual(await finalize(unclaimed, unclaimedRouter), { recovered: true, action: 'rolled_back' })
  assertRolledBack(unclaimed)
  assert.equal(unclaimed.successfulRestarts, 2, 'unclaimed rotation must restart the restored old runtime')

  const preCommitCrash = createFixture('precommit_crash')
  await assert.rejects(
    main(installerArgs(preCommitCrash), runtime(preCommitCrash, routerFetch(), {
      onCheckpoint(context) {
        if (context.name === 'plugin_activated') throw new InstallerCrashSimulation()
      },
    })),
    InstallerCrashSimulation,
  )
  const preCommitState = installerStatePath(preCommitCrash.identityPath)
  assert.equal(existsSync(join(preCommitState, 'journal.json')), true)
  assert.equal(existsSync(join(preCommitState, 'pending-identity.json')), true)
  const transactionRoot = join(preCommitState, 'transactions', readdirSync(join(preCommitState, 'transactions'))[0])
  if (process.platform !== 'win32') {
    assert.equal(statSync(preCommitState).mode & 0o777, 0o700)
    assert.equal(statSync(join(preCommitState, 'journal.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(preCommitState, 'pending-identity.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(transactionRoot, 'env.snapshot')).mode & 0o777, 0o600)
    assert.equal(statSync(join(transactionRoot, 'plugin.snapshot')).mode & 0o777, 0o700)
    assert.equal(statSync(join(transactionRoot, 'verified-package')).mode & 0o777, 0o700)
    assert.equal(statSync(join(transactionRoot, 'verified-package', 'install.mjs')).mode & 0o777, 0o600)
  } else {
    for (const path of [
      preCommitState,
      join(preCommitState, 'journal.json'),
      join(preCommitState, 'pending-identity.json'),
      join(transactionRoot, 'env.snapshot'),
      join(transactionRoot, 'plugin.snapshot'),
      join(transactionRoot, 'verified-package'),
      join(transactionRoot, 'verified-package', 'install.mjs'),
    ]) assertWindowsPrivate(path)
  }
  const preCommitRecovery = await recoverInstallerTransaction(
    preCommitCrash.identityPath,
    preCommitCrash.target,
    'fake-hermes',
    { commandRunner: fakeHermesRunner(preCommitCrash) },
  )
  assert.deepEqual(preCommitRecovery, { recovered: true, action: 'rolled_back' })
  assertRolledBack(preCommitCrash)
  assert.equal(preCommitCrash.successfulRestarts, 1)

  const committedCrash = createFixture('committed_crash')
  const committedCrashRouter = routerFetch()
  let committedCrashCandidate
  await main(installerArgs(committedCrash), runtime(committedCrash, committedCrashRouter))
  await assert.rejects(
    finalize(committedCrash, committedCrashRouter, {
      onCheckpoint(context) {
        if (context.name === 'identity_committed') {
          committedCrashCandidate = JSON.parse(readFileSync(committedCrash.identityPath, 'utf8'))
          throw new InstallerCrashSimulation()
        }
      },
    }),
    InstallerCrashSimulation,
  )
  assert.ok(committedCrashCandidate)
  const committedRecovery = await recoverInstallerTransaction(
    committedCrash.identityPath,
    committedCrash.target,
    'fake-hermes',
    { commandRunner: fakeHermesRunner(committedCrash) },
  )
  assert.deepEqual(committedRecovery, { recovered: true, action: 'finalized' })
  assert.deepEqual(JSON.parse(readFileSync(committedCrash.identityPath, 'utf8')), committedCrashCandidate)
  assert.equal(existsSync(join(committedCrash.target, 'plugin.yaml')), true)
  assert.equal(existsSync(join(committedCrash.target, 'old-plugin.txt')), false)
  assert.equal(existsSync(installerStatePath(committedCrash.identityPath)), false)
  assert.equal(committedCrash.successfulRestarts, 1, 'committed recovery must not restart or roll back the new runtime')

  console.log('Hermes Hub Gateway installer smoke passed.')
} finally {
  if (server) await new Promise(resolvePromise => server.close(resolvePromise))
  if (redirectServer) await new Promise(resolvePromise => redirectServer.close(resolvePromise))
  if (redirectSink) await new Promise(resolvePromise => redirectSink.close(resolvePromise))
  if (packageServer) await new Promise(resolvePromise => packageServer.close(resolvePromise))
  if (packageRedirectSink) await new Promise(resolvePromise => packageRedirectSink.close(resolvePromise))
  rmSync(temporaryRoot, { recursive: true, force: true })
}
