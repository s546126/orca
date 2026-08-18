#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONFIG_RELATIVE = join('config', 'pake.config.json')
const DEFAULT_WEB_OUT_RELATIVE = join('out', 'web')
const DEFAULT_PAKE_WEB_RELATIVE = join('out', 'pake-web')
const WEB_INDEX_NAME = 'web-index.html'
const PAKE_INDEX_NAME = 'index.html'
const LINUX_APPIMAGE_FORMAT = 'appimage'
const LINUX_DEB_FORMAT = 'deb'

export function resolveProjectDir(cwd = process.cwd()) {
  return resolve(cwd)
}

export function readPakeConfig(configPath) {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Pake config must be a JSON object: ${configPath}`)
  }
  return parsed
}

export function resolvePakeUrl(options) {
  const explicit = typeof options.url === 'string' ? options.url.trim() : ''
  if (explicit) {
    return explicit
  }
  return typeof options.configUrl === 'string' ? options.configUrl.trim() : ''
}

export function isRemotePakeUrl(url) {
  return /^https?:\/\//i.test(url)
}

export function preparePakeWebRoot({ projectDir, webOutDir, pakeWebDir }) {
  const indexSource = join(webOutDir, WEB_INDEX_NAME)
  if (!existsSync(indexSource)) {
    throw new Error(
      `Pake local packaging needs ${join(webOutDir, WEB_INDEX_NAME)}. Run \`pnpm run build:web\` first.`
    )
  }

  rmSync(pakeWebDir, { recursive: true, force: true })
  mkdirSync(dirname(pakeWebDir), { recursive: true })
  cpSync(webOutDir, pakeWebDir, { recursive: true })

  const stagedIndex = join(pakeWebDir, PAKE_INDEX_NAME)
  // Why: pake-cli only accepts a static directory that has index.html at its
  // root, and only hash routing. Pairing still serves web-index.html.
  writeFileSync(stagedIndex, readFileSync(indexSource))
  if (!existsSync(stagedIndex)) {
    throw new Error(`Failed to stage ${PAKE_INDEX_NAME} for Pake in ${pakeWebDir}`)
  }

  return {
    url: toConfigRelativePath(projectDir, pakeWebDir),
    indexPath: stagedIndex
  }
}

export function toConfigRelativePath(projectDir, targetPath) {
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(projectDir, targetPath)
  return absolute.startsWith(projectDir)
    ? absolute.slice(projectDir.length + 1).replaceAll('\\', '/')
    : absolute
}

export function parsePakeJsonStdout(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) {
    throw new Error('pake-cli --json produced empty stdout')
  }

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(
      `pake-cli --json stdout was not a single JSON object: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pake-cli --json stdout must be one object')
  }
  return parsed
}

export function assertPakeOutputs(result, requiredFormats = [LINUX_APPIMAGE_FORMAT]) {
  if (result.ok !== true) {
    const message = result.error?.message || 'pake-cli reported ok:false'
    const hint = result.error?.hint ? ` ${result.error.hint}` : ''
    throw new Error(`${message}${hint}`)
  }

  const outputs = Array.isArray(result.outputs) ? result.outputs : []
  const formats = new Set(
    outputs.map((output) => String(output?.format ?? '').toLowerCase()).filter(Boolean)
  )

  const missing = requiredFormats.filter((format) => !formats.has(format.toLowerCase()))
  if (missing.length > 0) {
    throw new Error(
      `pake-cli succeeded but outputs[] is missing required format(s): ${missing.join(', ')}`
    )
  }

  return outputs
}

export function buildPakeCliArgs({ configPath, url, targets }) {
  const args = ['--json', '--config', configPath]
  if (url) {
    args.push('--url', url)
  }
  if (targets) {
    args.push('--targets', targets)
  }
  return args
}

function resolveOptionalPath(projectDir, value, fallbackRelative) {
  if (typeof value === 'string' && value.trim()) {
    return isAbsolute(value) ? value : resolve(projectDir, value)
  }
  return resolve(projectDir, fallbackRelative)
}

export function runPakeBuild({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv.slice(2),
  spawn = spawnSync
} = {}) {
  const options = parseArgs(argv)
  const projectDir = resolveProjectDir(cwd)
  const configPath = resolveOptionalPath(projectDir, options.config, DEFAULT_CONFIG_RELATIVE)
  const config = readPakeConfig(configPath)
  const requestedUrl = resolvePakeUrl({
    url: options.url ?? env.ORCA_PAKE_URL,
    configUrl: config.url
  })

  let url = requestedUrl
  if (!isRemotePakeUrl(url)) {
    const webOutDir = resolveOptionalPath(projectDir, options.webOut, DEFAULT_WEB_OUT_RELATIVE)
    const pakeWebDir = resolveOptionalPath(projectDir, options.pakeWeb, DEFAULT_PAKE_WEB_RELATIVE)
    url = preparePakeWebRoot({ projectDir, webOutDir, pakeWebDir }).url
  }

  const targets = options.targets ?? env.ORCA_PAKE_TARGETS ?? config.targets ?? ''
  const cli = resolvePakeCliCommand(env)
  const args = [...cli.prefixArgs, ...buildPakeCliArgs({ configPath, url, targets })]

  const spawned = spawn(cli.command, args, {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })

  if (spawned.error) {
    throw spawned.error
  }
  if (spawned.status !== 0) {
    throw new Error(`pake-cli exited ${spawned.status ?? 'null'}`)
  }

  const result = parsePakeJsonStdout(spawned.stdout)
  const outputs = assertPakeOutputs(result, [LINUX_APPIMAGE_FORMAT])
  const formats = outputs.map((output) => output.format).filter(Boolean)
  if (!formats.map((format) => String(format).toLowerCase()).includes(LINUX_DEB_FORMAT)) {
    console.warn(
      '[build:pake] AppImage is present; deb was not in outputs[]. Linux multi-target builds can omit a format in warnings.'
    )
  }

  return { result, outputs, url }
}

function resolvePakeCliCommand(env) {
  const override = env.ORCA_PAKE_CLI?.trim()
  if (override) {
    return { command: override, prefixArgs: [] }
  }

  // Why: pake-cli is an optional packaging tool, not an Electron runtime dep.
  // Invoke through pnpm/npx so `build:linux` stays the supported desktop path.
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefixArgs: ['--yes', 'pake-cli']
  }
}

function parseArgs(argv) {
  const options = {
    config: null,
    url: null,
    targets: null,
    webOut: null,
    pakeWeb: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      index += 1
      return value
    }
    if (arg === '--config') {
      options.config = readValue()
    } else if (arg === '--url') {
      options.url = readValue()
    } else if (arg === '--targets') {
      options.targets = readValue()
    } else if (arg === '--web-out') {
      options.webOut = readValue()
    } else if (arg === '--pake-web') {
      options.pakeWeb = readValue()
    } else if (arg === '--help') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function printUsage() {
  console.log(`Usage: node config/scripts/run-pake-build.mjs [options]

Optional lightweight web-shell via pake-cli. Daemon, PTY, native modules, and
the packaged CLI stay on Electron (\`pnpm run build:linux\`).

Options:
  --config <path>   Pake JSON config (default config/pake.config.json)
  --url <url>       Remote \`orca serve\` URL, or omit to wrap out/web
  --targets <list>  Linux formats, default appimage,deb
  --web-out <dir>   Vite web build directory (default out/web)
  --pake-web <dir>  Staged directory with index.html (default out/pake-web)

Environment:
  ORCA_PAKE_URL      Same as --url (documented orca serve pairing URL)
  ORCA_PAKE_TARGETS  Same as --targets
  ORCA_PAKE_CLI      Override the pake-cli executable for tests
`)
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    const { outputs, url } = runPakeBuild()
    console.log(
      JSON.stringify(
        {
          ok: true,
          url,
          outputs: outputs.map((output) => ({
            path: output.path,
            format: output.format,
            sizeBytes: output.sizeBytes
          }))
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
