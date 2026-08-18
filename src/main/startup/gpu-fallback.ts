import { app } from 'electron'
import { getMainE2EConfig } from '../e2e-config'

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])

function parseBooleanEnvFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false
  }
  return TRUE_ENV_VALUES.has(value.trim().toLowerCase())
}

export function shouldUseLinuxSoftwareGpuFallback(
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    hasE2EUserDataDir?: boolean
  } = {}
): boolean {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') {
    return false
  }
  const env = options.env ?? process.env
  const e2eUserData = options.hasE2EUserDataDir ?? Boolean(getMainE2EConfig().userDataDir)
  // Why: Linux software-render / Xvfb / CI hosts crash when Chromium forks a
  // GPU process. Same path as #14858: disable-gpu + in-process-gpu.
  return (
    e2eUserData ||
    parseBooleanEnvFlag(env.ORCA_SOFTWARE_RENDER) ||
    parseBooleanEnvFlag(env.ORCA_DISABLE_GPU)
  )
}

export function applyLinuxSoftwareGpuFallback(): void {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('in-process-gpu')
}

export function enableMainProcessGpuFeatures(): void {
  if (shouldUseLinuxSoftwareGpuFallback()) {
    applyLinuxSoftwareGpuFallback()
    return
  }

  const existingFeatures = app.commandLine.getSwitchValue('enable-features')
  const features = [
    // Why: mirror VS Code's conservative Electron GPU-channel startup flags
    // instead of opting into Vulkan/SkiaGraphite/unsafe WebGPU globally.
    // Terminal acceleration is controlled by xterm WebGL in the renderer.
    'EarlyEstablishGpuChannel',
    'EstablishGpuChannelAsync',
    existingFeatures
  ]
    .filter(Boolean)
    .join(',')
  app.commandLine.appendSwitch('enable-features', features)
}
