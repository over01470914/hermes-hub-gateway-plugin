#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const installerScript = fileURLToPath(import.meta.url)
const moduleRoot = dirname(installerScript)
const pluginKey = 'hermes-hub-gateway'
const identityVersion = 1
const installerJournalVersion = 1
const defaultGatewayOnlineTimeoutMs = 90_000
const maxRouterResponseBytes = 1024 * 1024
const gatewayProtocol = 'hermes-hub-gateway-rpc/v1'
export const defaultGatewayPackageSourceBase =
  'https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/'
const packageManifestName = 'package-manifest.json'
const packageManifestSchema = 'hermes-hub-gateway-package/v1'
const packagePayloadFiles = Object.freeze([
  '__init__.py',
  'adapter.py',
  'protocol.py',
  'plugin.yaml',
  'install.mjs',
])
const packageFiles = Object.freeze([...packagePayloadFiles, packageManifestName])
const maxPackageManifestBytes = 64 * 1024
const maxPackageFileBytes = 2 * 1024 * 1024
const maxPackageBytes = 4 * 1024 * 1024
const installerPhases = new Set([
  'prepared',
  'approved',
  'plugin_swapping',
  'plugin_swapped',
  'configuring',
  'configured',
  'restarted',
  'gateway_verified',
  'awaiting_claim',
  'gateway_active',
  'identity_committed',
])

function argsOf(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) args._.push(item)
    else {
      const [key, inline] = item.slice(2).split('=', 2)
      if (inline !== undefined) args[key] = inline
      else if (argv[index + 1] && !argv[index + 1].startsWith('--')) args[key] = argv[++index]
      else args[key] = true
    }
  }
  return args
}

function text(args, name, fallback = '') {
  return typeof args[name] === 'string' ? args[name].trim() : fallback
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
}

function progress(message, quiet = false) {
  if (!quiet) process.stderr.write(`${message}\n`)
}

function hermesCommand(args, environment) {
  return text(args, 'hermes-command', environment.HERMES_COMMAND || 'hermes')
}

function commandResult(command, commandArgs) {
  return spawnSync(command, commandArgs, {
    encoding: 'utf8',
    windowsHide: true,
  })
}

function runCommand(command, commandArgs, runner = commandResult) {
  const result = runner(command, commandArgs)
  if (!result || typeof result !== 'object') throw new Error('Hermes command runner returned an invalid result.')
  return result
}

function commandOutput(command, commandArgs, runner = commandResult) {
  const result = runCommand(command, commandArgs, runner)
  if (result.status !== 0) throw new Error(`Hermes command failed: ${commandArgs.join(' ')}`)
  return String(result.stdout || '').trim()
}

function lastOutputLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .pop() || ''
}

export function resolveHermesHome(args, command, options = {}) {
  const environment = options.environment || process.env
  const explicit = text(args, 'hermes-home', environment.HERMES_HOME || '')
  if (explicit) return resolve(explicit)
  const configPath = lastOutputLine(commandOutput(command, ['config', 'path'], options.commandRunner))
  if (configPath) return dirname(resolve(configPath))
  throw new Error(
    'Could not determine Hermes home from `hermes config path`. Set HERMES_HOME or pass --hermes-home.',
  )
}

function hermesStateFiles(command, runner) {
  const configPath = lastOutputLine(commandOutput(command, ['config', 'path'], runner))
  const envPath = lastOutputLine(commandOutput(command, ['config', 'env-path'], runner))
  if (!configPath || !envPath) throw new Error('Hermes did not return its configuration and environment paths.')
  return { configPath: resolve(configPath), envPath: resolve(envPath) }
}

function hermesEnvValue(command, key, runner) {
  try {
    const envPath = lastOutputLine(commandOutput(command, ['config', 'env-path'], runner))
    if (!envPath || !existsSync(envPath)) return ''
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match || match[1] !== key) continue
      const raw = match[2].trim()
      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1)
      }
      return raw
    }
  } catch {
    return ''
  }
  return ''
}

function configuredValue(command, key, environment, runner) {
  return environment[key] || hermesEnvValue(command, key, runner) || ''
}

function verifyPluginDiscovery(command, runner) {
  const output = commandOutput(command, ['plugins', 'list', '--json', '--no-bundled'], runner)
  let plugins
  try {
    plugins = JSON.parse(output)
  } catch {
    throw new Error('Hermes returned an invalid plugin discovery response.')
  }
  const discovered = Array.isArray(plugins) && plugins.some(plugin => {
    return plugin && typeof plugin === 'object' && (plugin.key === pluginKey || plugin.name === pluginKey)
  })
  if (!discovered) throw new Error(`Hermes did not discover ${pluginKey} after installation.`)
}

function hermesConfigSet(command, key, value, runner) {
  const result = runCommand(command, ['config', 'set', key, value], runner)
  if (result.status !== 0) throw new Error(`Hermes rejected configuration key ${key}`)
}

function runHermes(command, commandArgs, runner) {
  const result = runCommand(command, commandArgs, runner)
  if (result.status !== 0) throw new Error(`Hermes command failed: ${commandArgs.join(' ')}`)
}

let cachedWindowsUserSid = ''

function windowsUserSid() {
  if (cachedWindowsUserSid) return cachedWindowsUserSid
  const result = commandResult('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
  const match = result.status === 0 ? String(result.stdout || '').match(/S-1-[0-9-]+/) : null
  if (!match) throw new Error('Could not determine the current Windows user for private installer state.')
  cachedWindowsUserSid = match[0]
  return cachedWindowsUserSid
}

function hardenPrivatePath(path, directory) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Private installer state has an unsafe filesystem type.')
  }
  if (process.platform === 'win32') {
    const permission = directory ? '(OI)(CI)F' : 'F'
    const commands = [
      [path, '/reset'],
      [path, '/inheritance:r'],
      [path, '/grant:r', `*${windowsUserSid()}:${permission}`],
    ]
    for (const commandArgs of commands) {
      const result = commandResult('icacls.exe', commandArgs)
      if (result.status !== 0) throw new Error('Could not restrict Windows permissions for private installer state.')
    }
    return
  }
  chmodSync(path, directory ? 0o700 : 0o600)
  const mode = lstatSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error('Could not restrict permissions for private installer state.')
}

function hardenPrivateTree(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('Private installer state must not contain symbolic links.')
  if (stat.isFile()) {
    hardenPrivatePath(path, false)
    return
  }
  if (!stat.isDirectory()) throw new Error('Private installer state contains an unsupported filesystem entry.')
  hardenPrivatePath(path, true)
  for (const entry of readdirSync(path)) hardenPrivateTree(join(path, entry))
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  hardenPrivatePath(path, true)
}

function fsyncDirectory(path) {
  if (process.platform === 'win32') return
  let descriptor
  try {
    descriptor = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function fsyncFile(path) {
  let descriptor
  try {
    descriptor = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function writePrivateFile(path, value) {
  const directory = dirname(path)
  ensurePrivateDirectory(directory)
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('Private installer state target must be a regular local file.')
    }
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, value)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    hardenPrivatePath(temporary, false)
    renameSync(temporary, path)
    hardenPrivatePath(path, false)
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    rmSync(temporary, { force: true })
  }
}

function writePrivateJson(path, value) {
  writePrivateFile(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

function readPrivateJson(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular local file.`)
  hardenPrivatePath(path, false)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} contains invalid JSON.`)
    throw error
  }
}

function copyDirectory(source, target, options = {}) {
  const sourceStat = lstatSync(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Plugin source or backup must be a regular directory without symbolic links.')
  }
  mkdirSync(target, { recursive: false, mode: options.private ? 0o700 : 0o755 })
  if (options.private) hardenPrivatePath(target, true)
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (options.filter && !options.filter(entry.name)) continue
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) throw new Error('Plugin trees must not contain symbolic links.')
    if (stat.isDirectory()) {
      copyDirectory(sourcePath, targetPath, options)
    } else if (stat.isFile()) {
      copyFileSync(sourcePath, targetPath)
      fsyncFile(targetPath)
      if (options.private) hardenPrivatePath(targetPath, false)
    } else {
      throw new Error('Plugin trees must contain only regular files and directories.')
    }
  }
  fsyncDirectory(target)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function validatePackageManifest(value, manifestBytes = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway package manifest must be a JSON object.')
  }
  if (!exactKeys(value, ['schema', 'version', 'files'])) {
    throw new Error('Gateway package manifest contains unsupported fields.')
  }
  if (value.schema !== packageManifestSchema) {
    throw new Error('Gateway package manifest schema is unsupported.')
  }
  if (typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.version)) {
    throw new Error('Gateway package manifest version is invalid.')
  }
  if (!Array.isArray(value.files) || value.files.length !== packagePayloadFiles.length) {
    throw new Error('Gateway package manifest file allowlist is invalid.')
  }

  const files = new Map()
  let totalBytes = manifestBytes
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ['name', 'bytes', 'sha256'])) {
      throw new Error('Gateway package manifest contains an invalid file entry.')
    }
    if (!packagePayloadFiles.includes(entry.name) || files.has(entry.name)) {
      throw new Error('Gateway package manifest file allowlist is invalid.')
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > maxPackageFileBytes) {
      throw new Error('Gateway package manifest file size is invalid or oversized.')
    }
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('Gateway package manifest file hash is invalid.')
    }
    totalBytes += entry.bytes
    if (totalBytes > maxPackageBytes) throw new Error('Gateway package exceeds the total size limit.')
    files.set(entry.name, { bytes: entry.bytes, sha256: entry.sha256 })
  }
  if (packagePayloadFiles.some(name => !files.has(name))) {
    throw new Error('Gateway package manifest file allowlist is invalid.')
  }
  return { schema: value.schema, version: value.version, files, totalBytes }
}

function readManifestBytes(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Gateway package manifest must be a regular local file.')
  }
  if (stat.size <= 0 || stat.size > maxPackageManifestBytes) {
    throw new Error('Gateway package manifest is empty or oversized.')
  }
  return readFileSync(path)
}

function parsePackageManifest(bytes) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Gateway package manifest contains invalid JSON.')
  }
  return validatePackageManifest(value, bytes.length)
}

function verifyExecutingInstaller(manifest) {
  const expected = manifest.files.get('install.mjs')
  const current = readFileSync(installerScript)
  if (current.length !== expected.bytes || sha256(current) !== expected.sha256) {
    throw new Error('The executing Gateway installer does not match the package manifest.')
  }
}

function verifyPackageDirectory(source, options = {}) {
  const sourceStat = lstatSync(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Gateway package source must be a regular local directory.')
  }
  const manifestBytes = readManifestBytes(join(source, packageManifestName))
  const manifest = parsePackageManifest(manifestBytes)
  if (options.verifyBootstrap !== false) verifyExecutingInstaller(manifest)
  for (const name of packagePayloadFiles) {
    const path = join(source, name)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Gateway package file ${name} must be a regular local file.`)
    }
    const expected = manifest.files.get(name)
    if (stat.size !== expected.bytes) throw new Error(`Gateway package file ${name} has an invalid byte length.`)
    const bytes = readFileSync(path)
    if (sha256(bytes) !== expected.sha256) throw new Error(`Gateway package file ${name} failed SHA-256 verification.`)
  }
  return manifest
}

function localPackageIsComplete(source) {
  const sourceStat = lstatSync(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Gateway installer directory must be a regular local directory.')
  }
  let complete = true
  for (const name of packageFiles) {
    const path = join(source, name)
    if (!existsSync(path)) {
      complete = false
      continue
    }
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Gateway package file ${name} must be a regular local file.`)
    }
  }
  return complete
}

function copyPackageFiles(source, target, options = {}) {
  if (existsSync(target)) throw new Error('Gateway package staging path already exists.')
  mkdirSync(target, { recursive: false, mode: options.private ? 0o700 : 0o755 })
  if (options.private) hardenPrivatePath(target, true)
  try {
    for (const name of packageFiles) {
      const sourcePath = join(source, name)
      const stat = lstatSync(sourcePath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Gateway package file ${name} must be a regular local file.`)
      }
      const targetPath = join(target, name)
      copyFileSync(sourcePath, targetPath)
      fsyncFile(targetPath)
      if (options.private) hardenPrivatePath(targetPath, false)
    }
    fsyncDirectory(target)
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

function validIdentityId(value, prefix) {
  return typeof value === 'string'
    && value.startsWith(prefix)
    && /^[A-Za-z0-9._:-]{8,160}$/.test(value)
}

function validGatewayToken(value) {
  return typeof value === 'string' && value.length >= 43 && value.length <= 512 && !/\s/.test(value)
}

function validateHostIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gateway host identity is invalid.')
  if (value.version !== identityVersion) throw new Error('Gateway host identity version is unsupported.')
  if (!validIdentityId(value.hermesAgentId, 'agent_')) throw new Error('Gateway host identity has an invalid Hermes Agent id.')
  if (!validIdentityId(value.gatewayId, 'gw_')) throw new Error('Gateway host identity has an invalid Gateway id.')
  if (!validGatewayToken(value.gatewayToken)) throw new Error('Gateway host identity has an invalid credential.')
  const identity = {
    version: identityVersion,
    hermesAgentId: value.hermesAgentId,
    gatewayId: value.gatewayId,
    gatewayToken: value.gatewayToken,
  }
  if (value.installerCommitId !== undefined) {
    if (typeof value.installerCommitId !== 'string' || !/^install_[A-Za-z0-9-]{8,80}$/.test(value.installerCommitId)) {
      throw new Error('Gateway host identity has an invalid installer commit id.')
    }
    identity.installerCommitId = value.installerCommitId
  }
  return identity
}

function generatedHostIdentity(existing = {}) {
  return {
    version: identityVersion,
    hermesAgentId: validIdentityId(existing.hermesAgentId, 'agent_')
      ? existing.hermesAgentId
      : `agent_${randomUUID()}`,
    gatewayId: validIdentityId(existing.gatewayId, 'gw_')
      ? existing.gatewayId
      : `gw_${randomUUID()}`,
    gatewayToken: validGatewayToken(existing.gatewayToken)
      ? existing.gatewayToken
      : randomBytes(48).toString('base64url'),
    installerCommitId: typeof existing.installerCommitId === 'string'
      ? existing.installerCommitId
      : `install_${randomUUID()}`,
  }
}

function readHostIdentity(path) {
  return validateHostIdentity(readPrivateJson(path, 'Gateway host identity'))
}

export function loadOrCreateHostIdentity(path, options = {}) {
  let identity = existsSync(path) ? readHostIdentity(path) : generatedHostIdentity(options.seed)
  if (options.rotateGateway) {
    identity = {
      ...identity,
      gatewayId: `gw_${randomUUID()}`,
      gatewayToken: randomBytes(48).toString('base64url'),
    }
  }
  writePrivateJson(path, identity)
  return identity
}

function candidateHostIdentity(path, options = {}) {
  let identity = existsSync(path) ? readHostIdentity(path) : generatedHostIdentity(options.seed)
  if (options.rotateGateway) {
    identity = {
      ...identity,
      gatewayId: `gw_${randomUUID()}`,
      gatewayToken: randomBytes(48).toString('base64url'),
    }
  }
  return { ...identity, installerCommitId: `install_${randomUUID()}` }
}

function sameIdentity(left, right) {
  return Boolean(left && right)
    && left.version === right.version
    && left.hermesAgentId === right.hermesAgentId
    && left.gatewayId === right.gatewayId
    && left.gatewayToken === right.gatewayToken
    && left.installerCommitId === right.installerCommitId
}

function installerStatePaths(identityFile) {
  const resolvedIdentity = resolve(identityFile)
  const stateRoot = join(dirname(resolvedIdentity), `.${basename(resolvedIdentity)}.install-state`)
  return {
    identityFile: resolvedIdentity,
    stateRoot,
    journalFile: join(stateRoot, 'journal.json'),
    pendingFile: join(stateRoot, 'pending-identity.json'),
    lockFile: join(stateRoot, 'install.lock'),
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function acquireInstallerLock(identityFile) {
  const state = installerStatePaths(identityFile)
  ensurePrivateDirectory(state.stateRoot)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomBytes(18).toString('base64url')
    let descriptor
    let created = false
    try {
      descriptor = openSync(state.lockFile, 'wx', 0o600)
      created = true
      writeFileSync(descriptor, `${JSON.stringify({
        version: installerJournalVersion,
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      })}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      hardenPrivatePath(state.lockFile, false)
      fsyncDirectory(state.stateRoot)
      return () => {
        if (!existsSync(state.lockFile)) throw new Error('Installer lock disappeared during installation.')
        const current = readPrivateJson(state.lockFile, 'Installer lock')
        if (current?.pid !== process.pid || current?.nonce !== nonce) {
          throw new Error('Installer lock ownership changed during installation.')
        }
        rmSync(state.lockFile, { force: true })
        fsyncDirectory(state.stateRoot)
        if (existsSync(state.stateRoot) && readdirSync(state.stateRoot).length === 0) {
          rmSync(state.stateRoot, { recursive: true, force: true })
        }
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch {}
      }
      if (created) rmSync(state.lockFile, { force: true })
      if (error?.code !== 'EEXIST') throw error
      let existing
      try {
        existing = readPrivateJson(state.lockFile, 'Installer lock')
      } catch {
        throw new Error('Installer lock is invalid; refusing to modify private Gateway state.')
      }
      if (existing?.version !== installerJournalVersion || !Number.isSafeInteger(existing?.pid)) {
        throw new Error('Installer lock is invalid; refusing to modify private Gateway state.')
      }
      if (processIsAlive(existing.pid)) {
        throw new Error('Another Hermes Hub Gateway installer is already running for this identity.')
      }
      rmSync(state.lockFile, { force: true })
      fsyncDirectory(state.stateRoot)
    }
  }
  throw new Error('Could not acquire the Hermes Hub Gateway installer lock.')
}

function transactionPaths(identityFile, target, transactionId) {
  const state = installerStatePaths(identityFile)
  const resolvedTarget = resolve(target)
  const transactionRoot = join(state.stateRoot, 'transactions', transactionId)
  const targetParent = dirname(resolvedTarget)
  const targetName = basename(resolvedTarget)
  return {
    ...state,
    target: resolvedTarget,
    transactionRoot,
    configBackup: join(transactionRoot, 'config.snapshot'),
    envBackup: join(transactionRoot, 'env.snapshot'),
    pluginBackup: join(transactionRoot, 'plugin.snapshot'),
    packageRoot: join(transactionRoot, 'verified-package'),
    pluginStage: join(targetParent, `.${targetName}.stage-${transactionId}`),
    pluginDisplaced: join(targetParent, `.${targetName}.rollback-${transactionId}`),
    pluginRestore: join(targetParent, `.${targetName}.restore-${transactionId}`),
    pluginFailed: join(targetParent, `.${targetName}.failed-${transactionId}`),
  }
}

function snapshotFile(sourcePath, backupPath) {
  if (!existsSync(sourcePath)) return { path: resolve(sourcePath), existed: false }
  const stat = lstatSync(sourcePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Hermes configuration state must be regular local files for transactional installation.')
  }
  writePrivateFile(backupPath, readFileSync(sourcePath))
  return { path: resolve(sourcePath), existed: true }
}

function restoreFile(snapshot, backupPath) {
  if (snapshot.existed) {
    if (!existsSync(backupPath)) throw new Error('Installer configuration snapshot is missing.')
    const stat = lstatSync(backupPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Installer configuration snapshot is unsafe.')
    writePrivateFile(snapshot.path, readFileSync(backupPath))
    return
  }
  if (existsSync(snapshot.path)) {
    const stat = lstatSync(snapshot.path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing to remove unsafe configuration state.')
    rmSync(snapshot.path, { force: true })
    fsyncDirectory(dirname(snapshot.path))
  }
}

function snapshotPlugin(target, backupPath) {
  if (!existsSync(target)) return { existed: false }
  const stat = lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Existing Hermes Hub Gateway plugin must be a regular local directory.')
  }
  copyDirectory(target, backupPath, { private: true })
  return { existed: true }
}

function validSnapshot(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.path === 'string'
    && resolve(value.path) === value.path
    && typeof value.existed === 'boolean'
}

function validateJournal(value, expectedIdentity, expectedTarget) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Installer journal is invalid.')
  if (value.version !== installerJournalVersion) throw new Error('Installer journal version is unsupported.')
  if (typeof value.transactionId !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(value.transactionId)) {
    throw new Error('Installer journal transaction id is invalid.')
  }
  if (!installerPhases.has(value.phase)) throw new Error('Installer journal phase is invalid.')
  if (resolve(value.identityFile || '') !== resolve(expectedIdentity) || resolve(value.target || '') !== resolve(expectedTarget)) {
    throw new Error('Installer recovery must use the same identity file and plugin target as the interrupted install.')
  }
  if (!validIdentityId(value.hermesAgentId, 'agent_') || !validIdentityId(value.gatewayId, 'gw_')) {
    throw new Error('Installer journal candidate identity is invalid.')
  }
  if (!validSnapshot(value.configSnapshot) || !validSnapshot(value.envSnapshot)) {
    throw new Error('Installer journal configuration snapshots are invalid.')
  }
  if (!value.pluginSnapshot || typeof value.pluginSnapshot.existed !== 'boolean') {
    throw new Error('Installer journal plugin snapshot is invalid.')
  }
  if (typeof value.runtimeMayBeMutated !== 'boolean') throw new Error('Installer journal mutation state is invalid.')
  const routerUrl = typeof value.routerUrl === 'string' && value.routerUrl
    ? normalizeRouterUrl(value.routerUrl)
    : ''
  const requestId = typeof value.requestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value.requestId)
    ? value.requestId
    : ''
  const approvalExpiresAtMs = Number(value.approvalExpiresAtMs || 0)
  const gatewayNotBefore = Number(value.gatewayNotBefore || 0)
  if (['awaiting_claim', 'gateway_active'].includes(value.phase)) {
    if (!routerUrl || !requestId || !Number.isFinite(approvalExpiresAtMs) || approvalExpiresAtMs <= 0) {
      throw new Error('Installer journal pairing finalization state is invalid.')
    }
  }
  return {
    version: installerJournalVersion,
    transactionId: value.transactionId,
    phase: value.phase,
    identityFile: resolve(value.identityFile),
    target: resolve(value.target),
    hermesAgentId: value.hermesAgentId,
    gatewayId: value.gatewayId,
    configSnapshot: { path: resolve(value.configSnapshot.path), existed: value.configSnapshot.existed },
    envSnapshot: { path: resolve(value.envSnapshot.path), existed: value.envSnapshot.existed },
    pluginSnapshot: { existed: value.pluginSnapshot.existed },
    runtimeMayBeMutated: value.runtimeMayBeMutated,
    routerUrl,
    requestId,
    approvalExpiresAtMs: Number.isFinite(approvalExpiresAtMs) ? approvalExpiresAtMs : 0,
    gatewayNotBefore: Number.isFinite(gatewayNotBefore) ? gatewayNotBefore : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
  }
}

function journalTransaction(identityFile, target) {
  const state = installerStatePaths(identityFile)
  const journal = validateJournal(
    readPrivateJson(state.journalFile, 'Installer journal'),
    identityFile,
    target,
  )
  return { journal, paths: transactionPaths(identityFile, target, journal.transactionId) }
}

function beginInstallerTransaction({ identityFile, target, candidate, configPath, envPath, routerUrl, requestId }) {
  const transactionId = randomUUID()
  const paths = transactionPaths(identityFile, target, transactionId)
  ensurePrivateDirectory(paths.stateRoot)
  ensurePrivateDirectory(dirname(paths.transactionRoot))
  ensurePrivateDirectory(paths.transactionRoot)
  try {
    writePrivateJson(paths.pendingFile, candidate)
    const configSnapshot = snapshotFile(configPath, paths.configBackup)
    const envSnapshot = snapshotFile(envPath, paths.envBackup)
    const pluginSnapshot = snapshotPlugin(paths.target, paths.pluginBackup)
    const journal = {
      version: installerJournalVersion,
      transactionId,
      phase: 'prepared',
      identityFile: paths.identityFile,
      target: paths.target,
      hermesAgentId: candidate.hermesAgentId,
      gatewayId: candidate.gatewayId,
      configSnapshot,
      envSnapshot,
      pluginSnapshot,
      runtimeMayBeMutated: false,
      routerUrl,
      requestId,
      approvalExpiresAtMs: 0,
      gatewayNotBefore: 0,
      createdAt: new Date().toISOString(),
    }
    writePrivateJson(paths.journalFile, journal)
    return { journal, paths, candidate }
  } catch (error) {
    rmSync(paths.journalFile, { force: true })
    rmSync(paths.pendingFile, { force: true })
    rmSync(paths.transactionRoot, { recursive: true, force: true })
    const transactionsRoot = dirname(paths.transactionRoot)
    if (existsSync(transactionsRoot) && readdirSync(transactionsRoot).length === 0) {
      rmSync(transactionsRoot, { recursive: true, force: true })
    }
    throw error
  }
}

function setTransactionState(transaction, changes) {
  transaction.journal = { ...transaction.journal, ...changes }
  writePrivateJson(transaction.paths.journalFile, transaction.journal)
}

function safeCheckpointContext(transaction, name) {
  return {
    name,
    phase: transaction.journal.phase,
    hermesAgentId: transaction.journal.hermesAgentId,
    gatewayId: transaction.journal.gatewayId,
  }
}

async function checkpoint(runtime, transaction, name) {
  if (typeof runtime.onCheckpoint === 'function') {
    await runtime.onCheckpoint(safeCheckpointContext(transaction, name))
  }
}

export class InstallerCrashSimulation extends Error {
  constructor(message = 'Simulated installer process crash.') {
    super(message)
    this.name = 'InstallerCrashSimulation'
  }
}

async function swapPlugin(transaction, runtime) {
  const { paths } = transaction
  mkdirSync(dirname(paths.target), { recursive: true })
  for (const path of [paths.pluginStage, paths.pluginDisplaced]) {
    if (existsSync(path)) throw new Error('Installer found an unexpected plugin transaction path.')
  }
  verifyPackageDirectory(paths.packageRoot, { verifyBootstrap: false })
  copyPackageFiles(paths.packageRoot, paths.pluginStage)
  verifyPackageDirectory(paths.pluginStage, { verifyBootstrap: false })
  await checkpoint(runtime, transaction, 'plugin_staged')
  let displaced = false
  try {
    if (existsSync(paths.target)) {
      renameSync(paths.target, paths.pluginDisplaced)
      displaced = true
      hardenPrivateTree(paths.pluginDisplaced)
    }
    await checkpoint(runtime, transaction, 'plugin_displaced')
    renameSync(paths.pluginStage, paths.target)
    fsyncDirectory(dirname(paths.target))
    await checkpoint(runtime, transaction, 'plugin_activated')
  } catch (error) {
    if (error instanceof InstallerCrashSimulation) throw error
    if (displaced && existsSync(paths.pluginDisplaced)) {
      if (existsSync(paths.target)) rmSync(paths.target, { recursive: true, force: true })
      renameSync(paths.pluginDisplaced, paths.target)
      fsyncDirectory(dirname(paths.target))
    }
    rmSync(paths.pluginStage, { recursive: true, force: true })
    throw error
  }
}

function atomicRestorePlugin(transaction) {
  const { journal, paths } = transaction
  rmSync(paths.pluginRestore, { recursive: true, force: true })
  rmSync(paths.pluginFailed, { recursive: true, force: true })
  if (!journal.pluginSnapshot.existed) {
    if (existsSync(paths.target)) {
      renameSync(paths.target, paths.pluginFailed)
      rmSync(paths.pluginFailed, { recursive: true, force: true })
    }
    rmSync(paths.pluginDisplaced, { recursive: true, force: true })
    rmSync(paths.pluginStage, { recursive: true, force: true })
    fsyncDirectory(dirname(paths.target))
    return
  }

  if (existsSync(paths.pluginDisplaced)) {
    let movedCurrent = false
    try {
      if (existsSync(paths.target)) {
        renameSync(paths.target, paths.pluginFailed)
        movedCurrent = true
      }
      renameSync(paths.pluginDisplaced, paths.target)
      fsyncDirectory(dirname(paths.target))
      rmSync(paths.pluginFailed, { recursive: true, force: true })
      rmSync(paths.pluginStage, { recursive: true, force: true })
      return
    } catch (error) {
      if (movedCurrent && !existsSync(paths.target) && existsSync(paths.pluginFailed)) {
        renameSync(paths.pluginFailed, paths.target)
        fsyncDirectory(dirname(paths.target))
      }
      throw error
    }
  }

  if (!existsSync(paths.pluginBackup)) throw new Error('Installer plugin snapshot is missing.')
  copyDirectory(paths.pluginBackup, paths.pluginRestore, { private: true })
  let movedCurrent = false
  try {
    if (existsSync(paths.target)) {
      renameSync(paths.target, paths.pluginFailed)
      movedCurrent = true
    }
    renameSync(paths.pluginRestore, paths.target)
    fsyncDirectory(dirname(paths.target))
    rmSync(paths.pluginFailed, { recursive: true, force: true })
    rmSync(paths.pluginStage, { recursive: true, force: true })
  } catch (error) {
    if (movedCurrent && !existsSync(paths.target) && existsSync(paths.pluginFailed)) {
      renameSync(paths.pluginFailed, paths.target)
      fsyncDirectory(dirname(paths.target))
    }
    throw error
  }
}

function cleanupTransaction(transaction) {
  const { paths } = transaction
  rmSync(paths.journalFile, { force: true })
  fsyncDirectory(paths.stateRoot)
  rmSync(paths.pluginStage, { recursive: true, force: true })
  rmSync(paths.pluginDisplaced, { recursive: true, force: true })
  rmSync(paths.pluginRestore, { recursive: true, force: true })
  rmSync(paths.pluginFailed, { recursive: true, force: true })
  rmSync(paths.pendingFile, { force: true })
  rmSync(paths.transactionRoot, { recursive: true, force: true })
  const transactionsRoot = dirname(paths.transactionRoot)
  if (existsSync(transactionsRoot) && readdirSync(transactionsRoot).length === 0) {
    rmSync(transactionsRoot, { recursive: true, force: true })
  }
  if (existsSync(paths.stateRoot) && readdirSync(paths.stateRoot).length === 0) {
    rmSync(paths.stateRoot, { recursive: true, force: true })
  }
}

function rollbackInstallerTransaction(transaction, command, runner) {
  if (transaction.journal.runtimeMayBeMutated) {
    atomicRestorePlugin(transaction)
    restoreFile(transaction.journal.configSnapshot, transaction.paths.configBackup)
    restoreFile(transaction.journal.envSnapshot, transaction.paths.envBackup)
    runHermes(command, ['gateway', 'restart'], runner)
  }
  cleanupTransaction(transaction)
}

function cleanupOrphanedInstallerState(identityFile, target) {
  const state = installerStatePaths(identityFile)
  if (existsSync(state.journalFile)) return
  if (existsSync(state.stateRoot)) {
    for (const entry of readdirSync(state.stateRoot)) {
      if (entry !== basename(state.lockFile)) {
        rmSync(join(state.stateRoot, entry), { recursive: true, force: true })
      }
    }
    if (readdirSync(state.stateRoot).length === 0) rmSync(state.stateRoot, { recursive: true, force: true })
  }
  const targetParent = dirname(resolve(target))
  if (!existsSync(targetParent)) return
  const targetName = basename(resolve(target)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const orphanPattern = new RegExp(`^\\.${targetName}\\.(?:stage|rollback|restore|failed)-[A-Za-z0-9-]{8,80}$`)
  for (const entry of readdirSync(targetParent)) {
    if (orphanPattern.test(entry)) rmSync(join(targetParent, entry), { recursive: true, force: true })
  }
}

export async function recoverInstallerTransaction(identityFile, target, command, options = {}) {
  const paths = installerStatePaths(identityFile)
  if (!existsSync(paths.journalFile)) {
    cleanupOrphanedInstallerState(identityFile, target)
    return { recovered: false, action: 'none' }
  }
  ensurePrivateDirectory(paths.stateRoot)
  const transaction = journalTransaction(identityFile, target)
  let candidate = null
  let committed = null
  try {
    if (existsSync(transaction.paths.pendingFile)) candidate = readHostIdentity(transaction.paths.pendingFile)
  } catch {
    candidate = null
  }
  try {
    if (existsSync(transaction.paths.identityFile)) committed = readHostIdentity(transaction.paths.identityFile)
  } catch {
    committed = null
  }
  if (sameIdentity(candidate, committed)) {
    cleanupTransaction(transaction)
    return { recovered: true, action: 'finalized' }
  }
  if (['awaiting_claim', 'gateway_active'].includes(transaction.journal.phase)) {
    if (!candidate) throw new InstallerPromotionIndeterminateError('Pending Gateway identity is missing; recovery state was retained.')
    try {
      const promotion = await waitForGatewayPromotion(
        transaction.journal.routerUrl,
        candidate.hermesAgentId,
        candidate.gatewayId,
        {
          expiresAtMs: transaction.journal.approvalExpiresAtMs,
          approvalToken: options.approvalToken,
          fetchImpl: options.fetchImpl,
          wait: options.waitForPromotion === true,
          pollMs: options.pollMs,
        },
      )
      if (promotion.status === 'pending') {
        return {
          recovered: true,
          action: 'pending',
          hermesAgentId: candidate.hermesAgentId,
          gatewayId: candidate.gatewayId,
        }
      }
      setTransactionState(transaction, { phase: 'gateway_active' })
      await checkpoint(options, transaction, 'gateway_active')
      writePrivateJson(transaction.paths.identityFile, candidate)
      setTransactionState(transaction, { phase: 'identity_committed' })
      await checkpoint(options, transaction, 'identity_committed')
      cleanupTransaction(transaction)
      return { recovered: true, action: 'finalized' }
    } catch (error) {
      if (!(error instanceof InstallerPairingExpiredError)) throw error
      rollbackInstallerTransaction(transaction, command, options.commandRunner)
      return { recovered: true, action: 'rolled_back' }
    }
  }
  rollbackInstallerTransaction(transaction, command, options.commandRunner)
  return { recovered: true, action: 'rolled_back' }
}

export async function installPlugin(target, options = {}) {
  const resolvedTarget = resolve(target)
  const transactionId = randomUUID()
  const paths = transactionPaths(
    join(dirname(resolvedTarget), `.copy-only-${transactionId}.json`),
    resolvedTarget,
    transactionId,
  )
  const transaction = {
    paths,
    journal: {
      phase: 'plugin_swapping',
      pluginSnapshot: { existed: existsSync(resolvedTarget) },
      hermesAgentId: 'agent_copy_only',
      gatewayId: 'gw_copy_only',
    },
  }
  ensurePrivateDirectory(paths.stateRoot)
  ensurePrivateDirectory(dirname(paths.transactionRoot))
  ensurePrivateDirectory(paths.transactionRoot)
  try {
    await stageVerifiedPluginPackage(transaction, options)
    await swapPlugin(transaction, {})
    rmSync(paths.pluginDisplaced, { recursive: true, force: true })
    rmSync(paths.pluginStage, { recursive: true, force: true })
  } finally {
    rmSync(paths.transactionRoot, { recursive: true, force: true })
    rmSync(paths.stateRoot, { recursive: true, force: true })
  }
}

export function normalizeRouterUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Router URL is invalid.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) throw new Error('Router URL must use http:// or https://.')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Router URL must not contain credentials, query, or fragment.')
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol === 'http:' && !loopback) throw new Error('A non-loopback Router URL must use HTTPS.')
  return parsed.toString().replace(/\/+$/, '')
}

export function normalizePackageSourceBase(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Gateway package source URL is invalid.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
    throw new Error('Gateway package source URL must use http:// or https://.')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Gateway package source URL must not contain credentials, query, or fragment.')
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('A non-loopback Gateway package source URL must use HTTPS.')
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`
  return parsed.toString()
}

function defaultPackageSourceBase() {
  return normalizePackageSourceBase(defaultGatewayPackageSourceBase)
}

export function resolvePackageFileUrl(sourceBase, name) {
  const parsed = new URL(normalizePackageSourceBase(sourceBase))
  const treeMarker = '/-/tree/'
  const treeIndex = parsed.pathname.indexOf(treeMarker)
  if (parsed.hostname.toLowerCase() === 'cnb.cool' && treeIndex >= 0) {
    const treePath = parsed.pathname.slice(treeIndex + treeMarker.length)
    const refSeparator = treePath.indexOf('/')
    if (refSeparator <= 0 || refSeparator === treePath.length - 1) {
      throw new Error('CNB Gateway package source URL must include a ref and directory path.')
    }
    const ref = treePath.slice(0, refSeparator)
    const directory = treePath.slice(refSeparator + 1).replace(/\/+$/, '')
    parsed.pathname = `${parsed.pathname.slice(0, treeIndex)}/-/git/raw/${ref}/${directory}/`
  }
  return new URL(name, parsed).toString()
}

export function packageRequestHeaders(url, name, environment = process.env) {
  const headers = {
    accept: name === packageManifestName ? 'application/json' : 'application/octet-stream',
  }
  const token = typeof environment.CNB_TOKEN === 'string' ? environment.CNB_TOKEN.trim() : ''
  if (new URL(url).hostname.toLowerCase() === 'cnb.cool' && token) {
    headers.authorization = `Basic ${Buffer.from(`cnb:${token}`).toString('base64')}`
  }
  return headers
}

async function boundedResponseBytes(response, maximumBytes, label) {
  const rawContentLength = response.headers?.get?.('content-length')
  if (rawContentLength && !/^\d+$/.test(rawContentLength)) {
    throw new Error(`${label} has an invalid content length.`)
  }
  const contentEncoding = response.headers?.get?.('content-encoding')?.trim().toLowerCase()
  const contentLength = Number(response.headers?.get?.('content-length') || 0)
  // Fetch exposes the decoded response body, while Content-Length is commonly
  // the compressed byte count. The streamed decoded-byte bound below remains
  // authoritative for compressed responses.
  if ((!contentEncoding || contentEncoding === 'identity') && Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`${label} is too large.`)
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maximumBytes) {
      throw new Error(`${label} is too large.`)
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${label} is too large.`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function boundedResponseText(response) {
  return (await boundedResponseBytes(response, maxRouterResponseBytes, 'Router response')).toString('utf8')
}

async function fetchPackageBytes(sourceBase, name, maximumBytes, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('This installer requires Node.js with fetch support.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const url = resolvePackageFileUrl(sourceBase, name)
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: packageRequestHeaders(url, name),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error(`Gateway package redirects are not allowed (${response.status}).`)
    }
    if (!response.ok) {
      const authenticationHint = new URL(url).hostname.toLowerCase() === 'cnb.cool'
        && response.status === 404
        && !process.env.CNB_TOKEN?.trim()
        ? ' Set a machine-local read-only CNB_TOKEN if the repository is private.'
        : ''
      throw new Error(
        `Gateway package file ${name} could not be downloaded (${response.status}).${authenticationHint}`,
      )
    }
    return await boundedResponseBytes(response, maximumBytes, `Gateway package file ${name}`)
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Gateway package file ${name} download timed out.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function downloadVerifiedPackage(sourceBase, target, fetchImpl) {
  const normalizedSource = normalizePackageSourceBase(sourceBase)
  if (existsSync(target)) throw new Error('Gateway package staging path already exists.')
  ensurePrivateDirectory(target)
  try {
    const manifestBytes = await fetchPackageBytes(
      normalizedSource,
      packageManifestName,
      maxPackageManifestBytes,
      fetchImpl,
    )
    const manifest = parsePackageManifest(manifestBytes)
    verifyExecutingInstaller(manifest)
    writePrivateFile(join(target, packageManifestName), manifestBytes)

    let actualTotalBytes = manifestBytes.length
    for (const name of packagePayloadFiles) {
      const expected = manifest.files.get(name)
      const bytes = await fetchPackageBytes(normalizedSource, name, expected.bytes, fetchImpl)
      if (bytes.length !== expected.bytes) {
        throw new Error(`Gateway package file ${name} has an invalid byte length.`)
      }
      actualTotalBytes += bytes.length
      if (actualTotalBytes > maxPackageBytes) throw new Error('Gateway package exceeds the total size limit.')
      if (sha256(bytes) !== expected.sha256) {
        throw new Error(`Gateway package file ${name} failed SHA-256 verification.`)
      }
      writePrivateFile(join(target, name), bytes)
    }
    verifyPackageDirectory(target)
    hardenPrivateTree(target)
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

async function stageVerifiedPluginPackage(transaction, options = {}) {
  const explicitSource = typeof options.sourceBase === 'string' ? options.sourceBase.trim() : ''
  if (!explicitSource && localPackageIsComplete(moduleRoot)) {
    verifyPackageDirectory(moduleRoot)
    copyPackageFiles(moduleRoot, transaction.paths.packageRoot, { private: true })
    verifyPackageDirectory(transaction.paths.packageRoot)
    return transaction.paths.packageRoot
  }
  const sourceBase = explicitSource || defaultPackageSourceBase()
  await downloadVerifiedPackage(sourceBase, transaction.paths.packageRoot, options.fetchImpl)
  return transaction.paths.packageRoot
}

async function fetchJson(url, options = {}, timeoutMs = 15_000, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('This installer requires Node.js with fetch support.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error(`Router redirects are not allowed (${response.status}).`)
    }
    const bodyText = await boundedResponseText(response)
    let body = {}
    if (bodyText) {
      try { body = JSON.parse(bodyText) } catch { throw new Error(`Router returned invalid JSON (${response.status}).`) }
    }
    return { status: response.status, ok: response.ok, body }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Router request timed out.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function approvePairing(routerUrl, requestId, identity, options = {}) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new Error('Pairing request id is invalid.')
  const headers = { 'content-type': 'application/json' }
  if (options.approvalToken) headers['x-hermes-hub-agent-approval'] = options.approvalToken
  const result = await fetchJson(
    `${normalizeRouterUrl(routerUrl)}/router/pairing/approve`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId,
        hermesAgentId: identity.hermesAgentId,
        gatewayId: identity.gatewayId,
        gatewayToken: identity.gatewayToken,
      }),
    },
    options.timeoutMs || 15_000,
    options.fetchImpl,
  )
  if (!result.ok) throw new Error(`Router pairing approval failed (${result.status}).`)
  const body = result.body && typeof result.body === 'object' ? result.body : {}
  if (!/^\d{8}$/.test(body.randomCode || '')) throw new Error('Router did not return a valid 8-digit pairing code.')
  if (body.hermesAgentId !== identity.hermesAgentId || body.gatewayId !== identity.gatewayId) {
    throw new Error('Router pairing approval returned a different host identity.')
  }
  if (body.gatewayToken !== undefined && body.gatewayToken !== identity.gatewayToken) {
    throw new Error('Router pairing approval returned a different Gateway credential.')
  }
  const numericExpiry = typeof body.expiresAt === 'number'
    ? (body.expiresAt < 1_000_000_000_000 ? body.expiresAt * 1_000 : body.expiresAt)
    : Number.NaN
  const expiresAtMs = Number.isFinite(numericExpiry) ? numericExpiry : Date.parse(body.expiresAt || '')
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() + 5_000) {
    throw new Error('Router pairing approval is already expired or too close to expiry.')
  }
  return { randomCode: body.randomCode, expiresAt: body.expiresAt, expiresAtMs }
}

export async function waitForGatewayOnline(routerUrl, hermesAgentId, gatewayId, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, defaultGatewayOnlineTimeoutMs, 1_000, 600_000)
  const pollMs = positiveInteger(options.pollMs, 750, 50, 10_000)
  const deadline = Date.now() + timeoutMs
  const notBefore = Number.isFinite(options.notBefore) ? options.notBefore : 0
  const gatewayUrl = `${normalizeRouterUrl(routerUrl)}/router/hermes-hub-gateways/${encodeURIComponent(gatewayId)}`
  const headers = { accept: 'application/json' }
  if (options.approvalToken) headers['x-hermes-hub-agent-approval'] = options.approvalToken
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(
        gatewayUrl,
        { method: 'GET', headers },
        Math.min(5_000, Math.max(1_000, deadline - Date.now())),
        options.fetchImpl,
      )
      const gateway = result.ok && result.body && typeof result.body === 'object' && !Array.isArray(result.body)
        ? result.body
        : null
      if (
        gateway?.gatewayId === gatewayId
        && gateway?.hermesAgentId === hermesAgentId
        && gateway?.online === true
        && Array.isArray(gateway?.protocols)
        && gateway.protocols.includes(gatewayProtocol)
        && Number(gateway?.connectedAt || 0) >= notBefore
      ) return gateway
    } catch {
      // Gateway restart and Router registration are eventually consistent.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
  throw new Error('Router did not confirm this exact Hermes Hub Gateway connection online before the timeout.')
}

export class InstallerPairingExpiredError extends Error {
  constructor(message = 'Pairing was not claimed before the candidate Gateway credential expired.') {
    super(message)
    this.name = 'InstallerPairingExpiredError'
  }
}

export class InstallerPromotionIndeterminateError extends Error {
  constructor(message = 'Router could not authoritatively confirm candidate Gateway promotion; installer state was retained.') {
    super(message)
    this.name = 'InstallerPromotionIndeterminateError'
  }
}

export async function waitForGatewayPromotion(routerUrl, hermesAgentId, gatewayId, options = {}) {
  const expiresAtMs = Number(options.expiresAtMs || 0)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error('Pairing promotion expiry is invalid.')
  }
  const wait = options.wait !== false
  const pollMs = positiveInteger(options.pollMs, 750, 50, 10_000)
  const gatewayUrl = `${normalizeRouterUrl(routerUrl)}/router/hermes-hub-gateways/${encodeURIComponent(gatewayId)}`
  const headers = { accept: 'application/json' }
  if (options.approvalToken) headers['x-hermes-hub-agent-approval'] = options.approvalToken
  let authoritativePending = false
  let lastGateway = null

  while (true) {
    try {
      const result = await fetchJson(
        gatewayUrl,
        { method: 'GET', headers },
        Math.min(5_000, Math.max(1_000, expiresAtMs - Date.now())),
        options.fetchImpl,
      )
      if (result.status === 401 || result.status === 403) {
        throw new InstallerPromotionIndeterminateError(
          'Router operator approval is required to finalize the pending Gateway installation.',
        )
      }
      if (result.status === 404) authoritativePending = true
      if (result.ok && result.body && typeof result.body === 'object' && !Array.isArray(result.body)) {
        const gateway = result.body
        if (gateway.gatewayId === gatewayId && gateway.hermesAgentId === hermesAgentId) {
          lastGateway = gateway
          if (gateway.gatewayCredentialState === 'active') return { status: 'active', gateway }
          if (gateway.gatewayCredentialState === 'revoked') throw new InstallerPairingExpiredError()
          if (gateway.gatewayCredentialState === 'provisional') authoritativePending = true
        }
      }
    } catch (error) {
      if (error instanceof InstallerPairingExpiredError || error instanceof InstallerPromotionIndeterminateError) {
        throw error
      }
      // Transient Router/network errors are indeterminate until an authoritative
      // state is observed or the pairing expiry is reached.
    }

    if (!wait && Date.now() < expiresAtMs) {
      if (authoritativePending) return { status: 'pending', gateway: lastGateway }
      throw new InstallerPromotionIndeterminateError()
    }
    if (Date.now() >= expiresAtMs) {
      if (authoritativePending) throw new InstallerPairingExpiredError()
      throw new InstallerPromotionIndeterminateError()
    }
    await new Promise(resolvePromise => setTimeout(
      resolvePromise,
      Math.min(pollMs, Math.max(0, expiresAtMs - Date.now())),
    ))
  }
}

function identityPath(args, hermesHome, environment) {
  const explicit = text(args, 'identity-file', environment.HERMES_HUB_GATEWAY_IDENTITY_FILE || '')
  return explicit ? resolve(explicit) : join(hermesHome, 'platforms', pluginKey, 'identity.json')
}

function configureHermes(args, command, routerUrl, identity, environment, runner) {
  const apiPort = positiveInteger(text(args, 'api-port', '8642'), 8642, 1, 65535)
  const apiKey = configuredValue(command, 'API_SERVER_KEY', environment, runner) || randomBytes(32).toString('base64url')
  const values = {
    API_SERVER_ENABLED: 'true',
    API_SERVER_HOST: '127.0.0.1',
    API_SERVER_PORT: String(apiPort),
    API_SERVER_KEY: apiKey,
    HERMES_HUB_ROUTER_URL: routerUrl,
    HERMES_HUB_AGENT_ID: identity.hermesAgentId,
    HERMES_HUB_GATEWAY_ID: identity.gatewayId,
    HERMES_HUB_GATEWAY_TOKEN: identity.gatewayToken,
    HERMES_HUB_LOCAL_API_URL: `http://127.0.0.1:${apiPort}`,
  }
  for (const [key, value] of Object.entries(values)) hermesConfigSet(command, key, value, runner)
  runHermes(command, ['plugins', 'enable', pluginKey, '--no-allow-tool-override'], runner)
}

async function acquireInstallerLockWithRetry(identityFile, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return acquireInstallerLock(identityFile)
    } catch (error) {
      if (!String(error?.message || '').includes('installer is already running') || Date.now() >= deadline) throw error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
  }
}

async function startDetachedFinalizer({ args, command, environment, hermesHome, identityFile, target }) {
  const installedInstaller = join(resolve(target), 'install.mjs')
  const installedStat = lstatSync(installedInstaller)
  if (!installedStat.isFile() || installedStat.isSymbolicLink()) {
    throw new Error('Installed Gateway finalizer is missing or unsafe.')
  }
  const childArgs = [
    installedInstaller,
    '--finalize-transaction',
    '--hermes-home', hermesHome,
    '--identity-file', identityFile,
    '--target', target,
    '--hermes-command', command,
    '--quiet',
  ]
  if (args['heartbeat-timeout-seconds']) {
    childArgs.push('--heartbeat-timeout-seconds', text(args, 'heartbeat-timeout-seconds'))
  }
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    env: { ...process.env, ...environment },
    stdio: 'ignore',
    windowsHide: true,
  })
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise)
    child.once('error', reject)
  })
  child.unref()
}

async function scheduleFinalizer(runtime, context) {
  if (typeof runtime.startFinalizer === 'function') {
    await runtime.startFinalizer({
      hermesAgentId: context.candidate?.hermesAgentId || '',
      gatewayId: context.candidate?.gatewayId || '',
    })
    return
  }
  await startDetachedFinalizer(context)
}

function usage() {
  return [
    'Hermes Hub Gateway installer',
    '',
    'Required pairing arguments:',
    '  --router <url> --request-id <pair-id>',
    '',
    'Optional:',
    '  --rotate-gateway              rotate only Gateway id/credential',
    '  --hermes-home <path>          explicit Hermes home',
    '  --hermes-command <path>       explicit Hermes CLI',
    '  --identity-file <path>        explicit private host identity file',
    '  --source-base <url>           explicit Gateway package source folder',
    '  --heartbeat-timeout-seconds N wait up to N seconds',
    '  --quiet                       suppress progress on stderr',
    '  --copy-only --target <path>   package-copy smoke mode',
  ].join('\n')
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const args = argsOf(argv)
  if (args.help || args._[0] === 'help') {
    process.stdout.write(`${usage()}\n`)
    return null
  }
  const quiet = args.quiet === true
  const environment = runtime.environment || process.env
  const runner = runtime.commandRunner
  if (args['copy-only']) {
    const target = text(args, 'target')
    if (!target) throw new Error('--copy-only requires --target.')
    await installPlugin(resolve(target), {
      routerUrl: text(args, 'router', environment.HERMES_HUB_ROUTER_URL || ''),
      sourceBase: text(args, 'source-base'),
      fetchImpl: runtime.fetchImpl,
    })
    return null
  }

  if (args['finalize-transaction']) {
    const command = hermesCommand(args, environment)
    const hermesHome = resolveHermesHome(args, command, { environment, commandRunner: runner })
    const formalIdentityPath = identityPath(args, hermesHome, environment)
    const target = text(args, 'target')
      ? resolve(text(args, 'target'))
      : join(hermesHome, 'plugins', pluginKey)
    const releaseInstallerLock = await acquireInstallerLockWithRetry(formalIdentityPath)
    try {
      await recoverInstallerTransaction(formalIdentityPath, target, command, {
        approvalToken: environment.HERMES_HUB_AGENT_APPROVAL_TOKEN || '',
        commandRunner: runner,
        fetchImpl: runtime.fetchImpl,
        waitForPromotion: true,
        onCheckpoint: runtime.onCheckpoint,
      })
      return null
    } finally {
      releaseInstallerLock()
    }
  }

  const routerUrl = normalizeRouterUrl(text(args, 'router', environment.HERMES_HUB_ROUTER_URL || ''))
  const requestId = text(args, 'request-id')
  if (!requestId) throw new Error(`Missing --request-id.\n${usage()}`)
  const command = hermesCommand(args, environment)
  const hermesHome = resolveHermesHome(args, command, { environment, commandRunner: runner })
  const formalIdentityPath = identityPath(args, hermesHome, environment)
  const target = text(args, 'target')
    ? resolve(text(args, 'target'))
    : join(hermesHome, 'plugins', pluginKey)
  const releaseInstallerLock = acquireInstallerLock(formalIdentityPath)

  try {
  const recovery = await recoverInstallerTransaction(formalIdentityPath, target, command, {
    approvalToken: environment.HERMES_HUB_AGENT_APPROVAL_TOKEN || '',
    commandRunner: runner,
    fetchImpl: runtime.fetchImpl,
    waitForPromotion: false,
  })
  if (recovery.action === 'pending') {
    await scheduleFinalizer(runtime, {
      args,
      command,
      environment,
      hermesHome,
      identityFile: formalIdentityPath,
      target,
      candidate: {
        hermesAgentId: recovery.hermesAgentId,
        gatewayId: recovery.gatewayId,
      },
    })
    throw new Error(
      'A previous Gateway pairing is still awaiting Client claim; its detached finalizer was resumed.',
    )
  }
  if (recovery.recovered) progress(
    recovery.action === 'finalized'
      ? 'Completed cleanup for a previously committed Gateway installation.'
      : 'Rolled back an interrupted Gateway installation before retrying.',
    quiet,
  )

  const { configPath, envPath } = hermesStateFiles(command, runner)
  const seed = {
    hermesAgentId: configuredValue(command, 'HERMES_HUB_AGENT_ID', environment, runner),
    gatewayId: configuredValue(command, 'HERMES_HUB_GATEWAY_ID', environment, runner),
    gatewayToken: configuredValue(command, 'HERMES_HUB_GATEWAY_TOKEN', environment, runner),
  }
  const candidate = candidateHostIdentity(formalIdentityPath, {
    seed,
    rotateGateway: args['rotate-gateway'] === true,
  })
  const transaction = beginInstallerTransaction({
    identityFile: formalIdentityPath,
    target,
    candidate,
    configPath,
    envPath,
    routerUrl,
    requestId,
  })

  try {
    await checkpoint(runtime, transaction, 'prepared')
    await stageVerifiedPluginPackage(transaction, {
      routerUrl,
      sourceBase: text(args, 'source-base'),
      fetchImpl: runtime.fetchImpl,
    })
    await checkpoint(runtime, transaction, 'package_staged')
    const approvalToken = environment.HERMES_HUB_AGENT_APPROVAL_TOKEN || ''
    const approval = await approvePairing(routerUrl, requestId, candidate, {
      approvalToken,
      fetchImpl: runtime.fetchImpl,
    })
    setTransactionState(transaction, {
      phase: 'approved',
      approvalExpiresAtMs: approval.expiresAtMs,
    })
    await checkpoint(runtime, transaction, 'approved')
    progress('Router pairing approval accepted; candidate identity remains pending.', quiet)

    setTransactionState(transaction, { phase: 'plugin_swapping', runtimeMayBeMutated: true })
    await swapPlugin(transaction, runtime)
    if (!text(args, 'target')) verifyPluginDiscovery(command, runner)
    setTransactionState(transaction, { phase: 'plugin_swapped' })
    await checkpoint(runtime, transaction, 'plugin_swapped')
    progress(`Installed and verified ${pluginKey} through an atomic plugin swap.`, quiet)

    setTransactionState(transaction, { phase: 'configuring' })
    configureHermes(args, command, routerUrl, candidate, environment, runner)
    setTransactionState(transaction, { phase: 'configured' })
    await checkpoint(runtime, transaction, 'configured')
    progress('Hermes Gateway candidate configuration saved without exposing credentials.', quiet)

    const gatewayRestartStartedAt = Math.floor(Date.now() / 1000)
    runHermes(command, ['gateway', 'restart'], runner)
    setTransactionState(transaction, {
      phase: 'restarted',
      gatewayNotBefore: gatewayRestartStartedAt,
    })
    await checkpoint(runtime, transaction, 'restarted')
    progress('Hermes Gateway restarted; waiting for exact candidate registration.', quiet)

    const heartbeatTimeoutMs = positiveInteger(
      Number(text(args, 'heartbeat-timeout-seconds', '90')) * 1_000,
      defaultGatewayOnlineTimeoutMs,
      1_000,
      600_000,
    )
    const usablePairingWindowMs = approval.expiresAtMs - Date.now() - 5_000
    if (usablePairingWindowMs < 1_000) throw new Error('Pairing approval expired before Gateway startup completed.')
    await waitForGatewayOnline(routerUrl, candidate.hermesAgentId, candidate.gatewayId, {
      timeoutMs: Math.min(heartbeatTimeoutMs, usablePairingWindowMs),
      approvalToken,
      notBefore: gatewayRestartStartedAt,
      fetchImpl: runtime.fetchImpl,
    })
    setTransactionState(transaction, { phase: 'gateway_verified' })
    await checkpoint(runtime, transaction, 'gateway_verified')
    if (Date.now() >= approval.expiresAtMs) throw new Error('Pairing approval expired before the final code was ready.')

    setTransactionState(transaction, { phase: 'awaiting_claim' })
    await scheduleFinalizer(runtime, {
      args,
      command,
      environment,
      hermesHome,
      identityFile: formalIdentityPath,
      target,
      candidate,
    })
    progress('Detached finalizer is waiting for Client claim before committing the candidate identity.', quiet)

    if (typeof runtime.writeCode === 'function') runtime.writeCode(approval.randomCode)
    else process.stdout.write(`${approval.randomCode}\n`)
    return approval.randomCode
  } catch (error) {
    if (error instanceof InstallerCrashSimulation) throw error
    try {
      rollbackInstallerTransaction(transaction, command, runner)
    } catch {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
        + 'Local rollback did not complete; rerun the installer with the same paths to recover before retrying.',
      )
    }
    throw error
  }
  } finally {
    releaseInstallerLock()
  }
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
