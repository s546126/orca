// Why: Android shares EmulatorError (one class, stable codes for agents); these
// codes are the Android subset of EmulatorErrorCode. Gated on binder/adb/docker,
// never KVM — redroid is a host-kernel container, not a hardware VM.
export { EmulatorError } from './emulator-errors'

export type AndroidErrorCode =
  | 'emulator_adb_unavailable'
  | 'emulator_redroid_unreachable'
  | 'emulator_android_kernel_unsupported'
  | 'emulator_docker_unprivileged'
