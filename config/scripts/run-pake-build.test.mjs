import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPakeOutputs,
  buildPakeCliArgs,
  isRemotePakeUrl,
  parsePakeJsonStdout,
  preparePakeWebRoot,
  readPakeConfig,
  resolvePakeUrl,
  runPakeBuild
} from './run-pake-build.mjs'

function makeWebBuild(dir) {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'web-index.html'), '<!doctype html><title>Orca Web</title>\n')
  writeFileSync(join(dir, 'assets', 'app.js'), 'window.__ORCA_WEB_CLIENT__ = true\n')
}

describe('Pake packaging script', () => {
  it('reads the checked-in declarative Pake config', () => {
    const config = readPakeConfig(join(process.cwd(), 'config/pake.config.json'))

    expect(config.name).toBe('Orca')
    expect(config.title).toBe('Orca')
    expect(config.url).toBe('out/pake-web')
    expect(config.useLocalFile).toBe(true)
    expect(config.targets).toBe('appimage,deb')
    expect(config.icon).toBe('resources/build/icon.png')
    expect(config.identifier).toBe('com.stablyai.orca.web-shell')
  })

  it('prefers an explicit orca serve URL over the local web directory', () => {
    expect(
      resolvePakeUrl({
        url: 'http://127.0.0.1:6768/web-index.html',
        configUrl: 'out/pake-web'
      })
    ).toBe('http://127.0.0.1:6768/web-index.html')
    expect(isRemotePakeUrl('http://127.0.0.1:6768/web-index.html')).toBe(true)
    expect(isRemotePakeUrl('out/pake-web')).toBe(false)
  })

  it('stages index.html from the Vite web-index.html for hash-routing Pake', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-pake-web-'))
    const webOutDir = join(root, 'out', 'web')
    const pakeWebDir = join(root, 'out', 'pake-web')
    mkdirSync(webOutDir, { recursive: true })
    makeWebBuild(webOutDir)

    const staged = preparePakeWebRoot({ projectDir: root, webOutDir, pakeWebDir })

    expect(staged.url).toBe('out/pake-web')
    expect(readFileSync(join(pakeWebDir, 'index.html'), 'utf8')).toContain('Orca Web')
    expect(readFileSync(join(pakeWebDir, 'web-index.html'), 'utf8')).toContain('Orca Web')
    expect(readFileSync(join(pakeWebDir, 'assets', 'app.js'), 'utf8')).toContain(
      '__ORCA_WEB_CLIENT__'
    )
  })

  it('refuses to package when the web build is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-pake-missing-'))

    expect(() =>
      preparePakeWebRoot({
        projectDir: root,
        webOutDir: join(root, 'out', 'web'),
        pakeWebDir: join(root, 'out', 'pake-web')
      })
    ).toThrow('pnpm run build:web')
  })

  it('passes --json --config and treats CLI url/targets as winners', () => {
    expect(
      buildPakeCliArgs({
        configPath: 'config/pake.config.json',
        url: 'out/pake-web',
        targets: 'appimage,deb'
      })
    ).toEqual([
      '--json',
      '--config',
      'config/pake.config.json',
      '--url',
      'out/pake-web',
      '--targets',
      'appimage,deb'
    ])
  })

  it('requires outputs[] to include a Linux AppImage', () => {
    const result = {
      ok: true,
      name: 'Orca',
      platform: 'linux',
      arch: 'x64',
      outputs: [
        { path: '/tmp/Orca.AppImage', sizeBytes: 12, format: 'appimage' },
        { path: '/tmp/orca.deb', sizeBytes: 8, format: 'deb' }
      ],
      warnings: [],
      error: null
    }

    expect(assertPakeOutputs(parsePakeJsonStdout(JSON.stringify(result)))).toHaveLength(2)
    expect(() =>
      assertPakeOutputs({
        ok: true,
        outputs: [{ path: '/tmp/orca.deb', format: 'deb' }]
      })
    ).toThrow('appimage')
    expect(() =>
      assertPakeOutputs({
        ok: false,
        error: { code: 'ENV_MISSING', message: 'Rust missing', hint: 'install rustup' }
      })
    ).toThrow('Rust missing')
  })

  it('invokes pake-cli against the staged local web root', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-pake-run-'))
    const webOutDir = join(root, 'out', 'web')
    mkdirSync(webOutDir, { recursive: true })
    makeWebBuild(webOutDir)
    writeFileSync(
      join(root, 'pake.json'),
      JSON.stringify({
        name: 'Orca',
        url: 'out/pake-web',
        targets: 'appimage,deb',
        useLocalFile: true
      })
    )

    const spawned = []
    const { outputs, url } = runPakeBuild({
      cwd: root,
      argv: ['--config', 'pake.json', '--web-out', 'out/web', '--pake-web', 'out/pake-web'],
      spawn: (command, args, options) => {
        spawned.push({ command, args, cwd: options.cwd })
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            outputs: [{ path: join(root, 'Orca.AppImage'), format: 'appimage', sizeBytes: 4 }]
          }),
          error: undefined
        }
      }
    })

    expect(url).toBe('out/pake-web')
    expect(outputs[0].format).toBe('appimage')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toEqual(
      expect.arrayContaining(['--yes', 'pake-cli', '--json', '--config'])
    )
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--url', 'out/pake-web']))
  })
})
