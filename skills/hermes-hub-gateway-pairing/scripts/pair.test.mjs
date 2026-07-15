#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { collectChild, PairingFailure, runPairing, sanitizeReason } from './pair.mjs'

const committedRelease = JSON.parse(await readFile(new URL('../references/release.json', import.meta.url), 'utf8'))
const committedInstaller = await readFile(new URL('../../../install.mjs', import.meta.url))
const committedManifest = JSON.parse(await readFile(new URL('../../../package-manifest.json', import.meta.url), 'utf8'))
const committedSkill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')
const committedInstallerManifest = committedManifest.files.find(file => file.name === 'install.mjs')
assert.ok(committedInstallerManifest, 'local package manifest must describe install.mjs')
assert.equal(committedInstallerManifest.bytes, committedInstaller.length)
assert.equal(
  committedInstallerManifest.sha256,
  createHash('sha256').update(committedInstaller).digest('hex'),
)
assert.match(committedRelease.commit, /^[0-9a-f]{40}$/)
assert.equal(Number.isSafeInteger(committedRelease.installerBytes) && committedRelease.installerBytes > 0, true)
assert.match(committedRelease.installerSha256, /^[0-9a-f]{64}$/)
assert.equal(
  committedRelease.sourceUrl,
  `https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/${committedRelease.commit}/`,
)
assert.equal(committedRelease.manifestUrl, `${committedRelease.sourceUrl}package-manifest.json`)
assert.equal(committedRelease.installerUrl, `${committedRelease.sourceUrl}install.mjs`)
assert.match(committedSkill, /\[scripts\/pair\.mjs\]\(scripts\/pair\.mjs\)/)
assert.match(committedSkill, /\[templates\/pairing-request\.md\]\(templates\/pairing-request\.md\)/)

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'hermes-hub-skill-test-'))
let server

try {
  const requestId = 'pair_skill_success'
  let baseUrl = ''
  const installer = Buffer.from([
    "if (!process.env.HERMES_HUB_AGENT_APPROVAL_TOKEN) process.exit(20)",
    "const expected = ['--router', process.env.TEST_ROUTER, '--request-id', process.env.TEST_REQUEST_ID, '--source-base', process.env.TEST_SOURCE_BASE]",
    "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(21)",
    "process.stdout.write('12345678\\n')",
    '',
  ].join('\n'), 'utf8')
  const installerSha256 = createHash('sha256').update(installer).digest('hex')
  const requests = []
  let pairingStatus = 'pending'
  let pairingExpiresAt = Math.floor(Date.now() / 1000) + 300
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'GET' && request.url === '/router/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        gatewayPlugin: {
          release: {
            repositoryUrl: 'https://github.com/example/hermes-hub-gateway-plugin',
            commit: 'a'.repeat(40),
            sourceUrl: `${baseUrl}/package/`,
            manifestUrl: `${baseUrl}/package/package-manifest.json`,
            installerUrl: `${baseUrl}/installer.mjs`,
            installerBytes: installer.length,
            installerSha256,
          },
        },
      }))
      return
    }
    if (request.method === 'GET' && request.url === `/router/pairing/${requestId}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        requestId,
        status: pairingStatus,
        expiresAt: pairingExpiresAt,
      }))
      return
    }
    if (request.method === 'GET' && request.url === '/installer.mjs') {
      response.writeHead(200, {
        'content-type': 'text/javascript',
        'content-length': String(installer.length),
      })
      response.end(installer)
      return
    }
    response.writeHead(404, { 'content-length': '0' })
    response.end()
  })
  baseUrl = await listen(server)

  const release = {
    repositoryUrl: 'https://github.com/example/hermes-hub-gateway-plugin',
    commit: 'a'.repeat(40),
    sourceUrl: `${baseUrl}/package/`,
    manifestUrl: `${baseUrl}/package/package-manifest.json`,
    installerUrl: `${baseUrl}/installer.mjs`,
    installerBytes: installer.length,
    installerSha256,
  }
  const commandCalls = []
  const commandRunner = (command, args) => {
    commandCalls.push([command, args])
    if (command === process.execPath && args[0] === '--version') {
      return { status: 0, stdout: `${process.version}\n`, stderr: '' }
    }
    if (command === 'fake-hermes' && args[0] === '--version') {
      return { status: 0, stdout: 'Hermes 0.test\n', stderr: '' }
    }
    if (command === 'fake-hermes' && args[0] === 'config' && args[1] === 'path') {
      return { status: 0, stdout: `${join(temporaryRoot, 'config.yaml')}\n`, stderr: '' }
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' }
  }
  const environment = {
    ...process.env,
    HERMES_COMMAND: 'fake-hermes',
    HERMES_HUB_AGENT_APPROVAL_TOKEN: 'approval-secret-for-test-only',
    TEST_ROUTER: baseUrl,
    TEST_REQUEST_ID: requestId,
    TEST_SOURCE_BASE: release.sourceUrl,
  }

  const code = await runPairing({ router: baseUrl, requestId, release }, {
    environment,
    temporaryRoot,
    commandRunner,
  })

  assert.equal(code, '12345678')
  assert.deepEqual(commandCalls, [
    [process.execPath, ['--version']],
    ['fake-hermes', ['--version']],
    ['fake-hermes', ['config', 'path']],
  ])
  assert.deepEqual(requests, [
    'GET /router/health',
    `GET /router/pairing/${requestId}`,
    'GET /installer.mjs',
  ])

  let installerInvocation
  let installerInvocationCount = 0
  const delegatedCode = await runPairing({ router: baseUrl, requestId, release }, {
    environment,
    temporaryRoot,
    commandRunner,
    childRunner: async (command, args, inheritedEnvironment) => {
      installerInvocationCount += 1
      installerInvocation = { command, args, inheritedEnvironment }
      return { status: 0, signal: null, stdout: '12345678\n', stderr: '' }
    },
  })
  assert.equal(delegatedCode, '12345678')
  assert.equal(installerInvocationCount, 1)
  assert.equal(installerInvocation.command, process.execPath)
  assert.match(installerInvocation.args[0], /install\.mjs$/)
  assert.deepEqual(installerInvocation.args.slice(1), [
    '--router', baseUrl,
    '--request-id', requestId,
    '--source-base', release.sourceUrl,
  ])
  assert.equal(installerInvocation.inheritedEnvironment, environment)

  requests.length = 0
  commandCalls.length = 0
  const { HERMES_HUB_AGENT_APPROVAL_TOKEN: _removed, ...environmentWithoutApproval } = environment
  let childCalls = 0
  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, {
      environment: environmentWithoutApproval,
      temporaryRoot,
      commandRunner,
      childRunner: async () => {
        childCalls += 1
        return { status: 0, signal: null, stdout: '12345678\n', stderr: '' }
      },
    }),
    error => error instanceof PairingFailure && error.step === 4 && error.message === 'approval credential missing',
  )
  assert.equal(childCalls, 0, 'missing approval credential must stop before installer execution')
  assert.deepEqual(requests, [
    'GET /router/health',
    `GET /router/pairing/${requestId}`,
    'GET /installer.mjs',
  ])

  requests.length = 0
  commandCalls.length = 0
  await assert.rejects(
    runPairing({
      router: baseUrl,
      requestId,
      release: { ...release, repositoryUrl: 'https://github.com/example/unexpected-plugin' },
    }, { environment, temporaryRoot, commandRunner }),
    error => error instanceof PairingFailure
      && error.step === 2
      && error.message === 'Router release mismatch for repositoryUrl',
  )
  assert.deepEqual(requests, ['GET /router/health'], 'release mismatch must stop before pairing lookup')

  requests.length = 0
  commandCalls.length = 0
  pairingExpiresAt = Math.floor(Date.now() / 1000) - 1
  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, { environment, temporaryRoot, commandRunner }),
    error => error instanceof PairingFailure && error.step === 2 && error.message === 'Router pairing request has expired',
  )
  assert.deepEqual(requests, ['GET /router/health', `GET /router/pairing/${requestId}`])
  pairingExpiresAt = Math.floor(Date.now() / 1000) + 300

  requests.length = 0
  commandCalls.length = 0
  const sensitiveFailure = `pairing approval failed (409): pairing_request_already_approved at "C:\\Users\\Alice\\secret\\state.json" token=${environment.HERMES_HUB_AGENT_APPROVAL_TOKEN}`
  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, {
      environment,
      temporaryRoot,
      commandRunner,
      childRunner: async () => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: `${sensitiveFailure}\n`,
      }),
    }),
    error => error instanceof PairingFailure
      && error.step === 4
      && error.message.includes('409')
      && error.message.includes('pairing_request_already_approved')
      && !error.message.includes('Alice')
      && !error.message.includes(environment.HERMES_HUB_AGENT_APPROVAL_TOKEN),
  )

  const multilineApprovalToken = 'abcdefghijklmnop\nqrstuvwxyzabcdef'
  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, {
      environment: {
        ...environment,
        HERMES_HUB_AGENT_APPROVAL_TOKEN: multilineApprovalToken,
      },
      temporaryRoot,
      commandRunner,
      childRunner: async () => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: `approval failed token=${multilineApprovalToken}\n`,
      }),
    }),
    error => error instanceof PairingFailure
      && error.step === 4
      && error.message.includes('[REDACTED]')
      && !error.message.includes('abcdefghijklmnop')
      && !error.message.includes('qrstuvwxyzabcdef'),
  )

  requests.length = 0
  commandCalls.length = 0
  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, {
      environment,
      temporaryRoot,
      commandRunner,
      childRunner: async () => ({
        status: 0,
        signal: null,
        stdout: '12345678\n87654321\n',
        stderr: '',
      }),
    }),
    error => error instanceof PairingFailure
      && error.step === 4
      && error.message.includes('not exactly one pairing code line'),
  )

  requests.length = 0
  commandCalls.length = 0
  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, {
      environment,
      temporaryRoot,
      commandRunner,
      childRunner: async () => ({
        status: 0,
        signal: null,
        stdout: 'unexpected stdout\n12345678\n',
        stderr: '',
      }),
    }),
    error => error instanceof PairingFailure
      && error.step === 4
      && error.message.includes('not exactly one pairing code line'),
  )

  assert.equal(pairingStatus, 'pending')

  requests.length = 0
  commandCalls.length = 0
  const stalledFetch = async (url, options) => {
    if (String(url).endsWith('/installer.mjs')) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]))
          options.signal.addEventListener('abort', () => controller.error(new Error('request timed out')), { once: true })
        },
      }), { status: 200 })
    }
    return fetch(url, options)
  }
  const bodyTimeoutResult = await Promise.race([
    runPairing({ router: baseUrl, requestId, release }, {
      environment,
      temporaryRoot,
      commandRunner,
      fetchImpl: stalledFetch,
      httpTimeoutMs: 40,
    }).then(
      () => ({ kind: 'success' }),
      error => ({ kind: 'failure', error }),
    ),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'hung' }), 150)),
  ])
  assert.notEqual(bodyTimeoutResult.kind, 'hung', 'HTTP timeout must remain active while the response body is read')
  assert.equal(bodyTimeoutResult.kind, 'failure')
  assert.ok(bodyTimeoutResult.error instanceof PairingFailure)
  assert.equal(bodyTimeoutResult.error.step, 3)
  assert.equal(bodyTimeoutResult.error.message, 'request timed out')

  assert.equal(
    sanitizeReason('HTTP 409 from /router/pairing/approve'),
    'HTTP 409 from /router/pairing/approve',
    'public Router route names are concrete protocol failures, not host paths',
  )
  assert.equal(sanitizeReason('failed at /home/alice/private/state.json'), 'failed at [HOST_PATH]')
  assert.equal(
    sanitizeReason('failed at C:\\Users\\Alice Smith\\private\\state.json'),
    'failed at [HOST_PATH]',
  )
  assert.equal(
    sanitizeReason('failed at \\\\server\\share\\Alice Smith\\state.json'),
    'failed at [HOST_PATH]',
  )
  assert.equal(sanitizeReason('path=/home/alice private/state.json'), 'path=[HOST_PATH]')
  assert.equal(
    sanitizeReason('failed path=\\\\server\\share\\Alice Smith\\state.json'),
    'failed path=[HOST_PATH]',
  )
  assert.equal(sanitizeReason('failed at file://server/share/Alice/state.json'), 'failed at [HOST_PATH]')
  assert.equal(
    sanitizeReason('failed (\\\\server\\share\\Alice Smith\\state.json)'),
    'failed ([HOST_PATH]',
  )
  assert.equal(
    sanitizeReason('HTTP 409 from "/router/pairing/approve"'),
    'HTTP 409 from "/router/pairing/approve"',
  )
  const multilineSecret = 'abcdefghijklmnop\nqrstuvwxyzabcdef'
  const sanitizedMultilineSecret = sanitizeReason(`approval failed: ${multilineSecret}`, [multilineSecret])
  assert.equal(sanitizedMultilineSecret, 'approval failed: [REDACTED]')
  assert.equal(sanitizeReason(`failure ${'x'.repeat(10_000)}`).length <= 2048, true)

  await assert.rejects(
    runPairing({ router: baseUrl, requestId, release }, {
      environment,
      temporaryRoot: join(temporaryRoot, 'missing-parent', 'nested'),
      commandRunner,
    }),
    error => error instanceof PairingFailure && error.step === 3,
    'OS temp directory failures must retain the step 3 contract',
  )

  commandCalls.length = 0
  await assert.rejects(
    runPairing({ router: 'not-a-router-url', requestId, release }, {
      environment,
      temporaryRoot,
      commandRunner,
    }),
    error => error instanceof PairingFailure && error.step === 2,
  )
  assert.deepEqual(commandCalls, [
    [process.execPath, ['--version']],
    ['fake-hermes', ['--version']],
    ['fake-hermes', ['config', 'path']],
  ], 'step 1 prerequisites must run before step 2 input and Router validation')

  const stubbornChild = new EventEmitter()
  stubbornChild.stdout = new PassThrough()
  stubbornChild.stderr = new PassThrough()
  const killSignals = []
  let childUnrefCalled = false
  stubbornChild.kill = signal => {
    killSignals.push(signal)
    return false
  }
  stubbornChild.unref = () => {
    childUnrefCalled = true
  }
  const boundedChildResult = await Promise.race([
    collectChild('fake-installer', [], environment, {
      timeoutMs: 10,
      terminateGraceMs: 10,
      closeGraceMs: 10,
      spawnImpl: () => stubbornChild,
    }).then(result => ({ kind: 'result', result })),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'hung' }), 250)),
  ])
  assert.equal(boundedChildResult.kind, 'result', 'installer timeout must remain a hard wall if kill/close never succeeds')
  assert.equal(boundedChildResult.result.timedOut, true)
  assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(childUnrefCalled, true)

  const killErrorChild = new EventEmitter()
  killErrorChild.stdout = new PassThrough()
  killErrorChild.stderr = new PassThrough()
  const killErrorSignals = []
  killErrorChild.kill = signal => {
    killErrorSignals.push(signal)
    if (signal === 'SIGTERM') queueMicrotask(() => killErrorChild.emit('error', new Error('kill EPERM')))
    return false
  }
  killErrorChild.unref = () => undefined
  const killErrorResult = await Promise.race([
    collectChild('fake-installer', [], environment, {
      timeoutMs: 10,
      terminateGraceMs: 10,
      closeGraceMs: 10,
      spawnImpl: () => killErrorChild,
    }).then(
      result => ({ kind: 'result', result }),
      error => ({ kind: 'rejected', error }),
    ),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'hung' }), 250)),
  ])
  assert.equal(killErrorResult.kind, 'result', 'kill errors must not cancel escalation or the hard close deadline')
  assert.equal(killErrorResult.result.timedOut, true)
  assert.deepEqual(killErrorSignals, ['SIGTERM', 'SIGKILL'])

  console.log('Hermes Hub Gateway pairing skill tests passed.')
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temporaryRoot, { recursive: true, force: true })
}
