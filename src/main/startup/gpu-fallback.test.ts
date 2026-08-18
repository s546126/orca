import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  return {
    app: {
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        getSwitchValue: vi.fn(() => '')
      }
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shouldUseLinuxSoftwareGpuFallback', () => {
  it('is off on macOS and Windows', async () => {
    const { shouldUseLinuxSoftwareGpuFallback } = await import('./gpu-fallback')

    expect(shouldUseLinuxSoftwareGpuFallback({ platform: 'darwin', hasE2EUserDataDir: true })).toBe(
      false
    )
    expect(
      shouldUseLinuxSoftwareGpuFallback({
        platform: 'win32',
        env: { ORCA_SOFTWARE_RENDER: '1' }
      })
    ).toBe(false)
  })

  it('follows Linux E2E, software-render, and disable-gpu flags', async () => {
    const { shouldUseLinuxSoftwareGpuFallback } = await import('./gpu-fallback')

    expect(shouldUseLinuxSoftwareGpuFallback({ platform: 'linux', hasE2EUserDataDir: true })).toBe(
      true
    )
    expect(
      shouldUseLinuxSoftwareGpuFallback({
        platform: 'linux',
        hasE2EUserDataDir: false,
        env: { ORCA_SOFTWARE_RENDER: 'true' }
      })
    ).toBe(true)
    expect(
      shouldUseLinuxSoftwareGpuFallback({
        platform: 'linux',
        hasE2EUserDataDir: false,
        env: { ORCA_DISABLE_GPU: '1' }
      })
    ).toBe(true)
    expect(
      shouldUseLinuxSoftwareGpuFallback({
        platform: 'linux',
        hasE2EUserDataDir: false,
        env: {}
      })
    ).toBe(false)
  })
})

describe('enableMainProcessGpuFeatures', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalE2EUserDataDir = process.env.ORCA_E2E_USER_DATA_DIR
  const originalSoftwareRender = process.env.ORCA_SOFTWARE_RENDER

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: platform
    })
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalE2EUserDataDir === undefined) {
      delete process.env.ORCA_E2E_USER_DATA_DIR
    } else {
      process.env.ORCA_E2E_USER_DATA_DIR = originalE2EUserDataDir
    }
    if (originalSoftwareRender === undefined) {
      delete process.env.ORCA_SOFTWARE_RENDER
    } else {
      process.env.ORCA_SOFTWARE_RENDER = originalSoftwareRender
    }
  })

  it('appends VS Code-style GPU channel flags without unsafe WebGPU/Vulkan opt-ins', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./gpu-fallback')

    delete process.env.ORCA_E2E_USER_DATA_DIR
    delete process.env.ORCA_SOFTWARE_RENDER
    vi.mocked(app.commandLine.appendSwitch).mockClear()
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'EarlyEstablishGpuChannel,EstablishGpuChannelAsync'
    )
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('enable-unsafe-webgpu')
  })

  it('uses the Linux software-render fallback for E2E runs', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./gpu-fallback')

    setPlatform('linux')
    process.env.ORCA_E2E_USER_DATA_DIR = '/tmp/orca-e2e'
    vi.mocked(app.disableHardwareAcceleration).mockClear()
    vi.mocked(app.commandLine.appendSwitch).mockClear()

    enableMainProcessGpuFeatures()

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1)
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu')
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu-compositing')
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('in-process-gpu')
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith(
      'enable-features',
      expect.any(String)
    )
  })

  it('preserves existing enable-features switches', async () => {
    const { app } = await import('electron')
    const { enableMainProcessGpuFeatures } = await import('./gpu-fallback')

    delete process.env.ORCA_E2E_USER_DATA_DIR
    vi.mocked(app.commandLine.appendSwitch).mockClear()
    vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('ExistingFeature')
    enableMainProcessGpuFeatures()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'EarlyEstablishGpuChannel,EstablishGpuChannelAsync,ExistingFeature'
    )
  })
})
