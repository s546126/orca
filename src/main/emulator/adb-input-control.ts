import { EmulatorError } from './emulator-errors'
import type { AdbCommandExecutor, AdbCommandResult } from './adb-command-execution'
import type { EmulatorGesturePoint } from './emulator-gesture-sender'

// Pure mappers from the existing 0..1-normalized RPC contract to `adb shell`
// argv. Backend-agnostic — shared by every Android backend. NO shell escaping
// here: the remote executor shell-escapes each token and local spawn passes argv
// directly, so quoting inside a builder would double-escape on the SSH path. The
// only text transforms are space->%s and emoji stripping (input text).

export type StreamSize = { width: number; height: number }
export type DeviceRotation = 0 | 1 | 2 | 3

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

// `input tap`/`input swipe` operate in the CURRENT display orientation, so the
// effective pixel box swaps width/height for the landscape rotations (1, 3).
// Rotated-space mapping assumption — some Android builds inject in natural space;
// flagged to verify on hardware.
export function effectiveSize(size: StreamSize, rotation: DeviceRotation): StreamSize {
  return rotation % 2 === 0 ? size : { width: size.height, height: size.width }
}

function toPixels(
  nx: number,
  ny: number,
  size: StreamSize,
  rotation: DeviceRotation
): { px: number; py: number } {
  const eff = effectiveSize(size, rotation)
  return {
    px: Math.round(clamp01(nx) * eff.width),
    py: Math.round(clamp01(ny) * eff.height)
  }
}

export function buildTapArgs(
  nx: number,
  ny: number,
  size: StreamSize,
  rotation: DeviceRotation
): string[] {
  const { px, py } = toPixels(nx, ny, size, rotation)
  return ['shell', 'input', 'tap', String(px), String(py)]
}

// Each `input swipe` spawns app_process (~100-300ms), so a many-segment polyline
// janks. The RPC allows up to 64 points; we downsample to a fixed low ceiling so
// cost is bounded (not input-proportional) — no smooth-drag promise on the adb
// path. One swipe per surviving consecutive pair.
export const DEFAULT_SWIPE_SEGMENT_MS = 60
export const MAX_GESTURE_SEGMENTS = 8

// Pick at most MAX_GESTURE_SEGMENTS+1 evenly-spaced points (always keeping the
// first and last) so the path shape is preserved while the swipe count is capped.
function downsamplePoints(points: EmulatorGesturePoint[]): EmulatorGesturePoint[] {
  if (points.length - 1 <= MAX_GESTURE_SEGMENTS) {
    return points
  }
  const last = points.length - 1
  const sampled: EmulatorGesturePoint[] = []
  for (let i = 0; i <= MAX_GESTURE_SEGMENTS; i += 1) {
    sampled.push(points[Math.round((i * last) / MAX_GESTURE_SEGMENTS)])
  }
  return sampled
}

export function buildGestureSwipeArgs(
  points: EmulatorGesturePoint[],
  size: StreamSize,
  rotation: DeviceRotation,
  segmentMs: number = DEFAULT_SWIPE_SEGMENT_MS
): string[][] {
  const sampled = downsamplePoints(points)
  const segments: string[][] = []
  for (let i = 0; i < sampled.length - 1; i += 1) {
    const from = toPixels(sampled[i].x, sampled[i].y, size, rotation)
    const to = toPixels(sampled[i + 1].x, sampled[i + 1].y, size, rotation)
    segments.push([
      'shell',
      'input',
      'swipe',
      String(from.px),
      String(from.py),
      String(to.px),
      String(to.py),
      String(segmentMs)
    ])
  }
  return segments
}

// `input text` cannot render astral-plane glyphs; strip emoji (and the joiners /
// variation selectors that compose them), then escape spaces as %s.
function isEmojiCodePoint(cp: number): boolean {
  return (
    cp > 0xffff || // all real emoji live in the astral planes
    cp === 0x200d || // zero-width joiner
    (cp >= 0x2600 && cp <= 0x27bf) || // misc symbols + dingbats
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  )
}

export function sanitizeTypeText(text: string): string {
  const stripped = [...text].filter((ch) => !isEmojiCodePoint(ch.codePointAt(0) ?? 0)).join('')
  return stripped.replace(/ /g, '%s')
}

export function buildTypeArgs(text: string): string[] {
  return ['shell', 'input', 'text', sanitizeTypeText(text)]
}

const BUTTON_KEYCODES: Record<string, string> = {
  home: 'KEYCODE_HOME',
  back: 'KEYCODE_BACK',
  recent: 'KEYCODE_APP_SWITCH',
  recents: 'KEYCODE_APP_SWITCH',
  power: 'KEYCODE_POWER',
  menu: 'KEYCODE_MENU',
  enter: 'KEYCODE_ENTER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volumeup: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  volumedown: 'KEYCODE_VOLUME_DOWN',
  volume_mute: 'KEYCODE_VOLUME_MUTE'
}

export function buttonKeycode(name: string): string {
  const trimmed = name.trim()
  const mapped = BUTTON_KEYCODES[trimmed.toLowerCase()]
  if (mapped) {
    return mapped
  }
  // Allow a raw KEYCODE_* or numeric keycode through; reject unknown words so a
  // typo never silently becomes a no-op keyevent.
  if (/^KEYCODE_[A-Z0-9_]+$/.test(trimmed) || /^\d+$/.test(trimmed)) {
    return trimmed
  }
  throw new EmulatorError('emulator_error', `Unknown Android button '${name}'.`)
}

export function buildButtonArgs(name: string): string[] {
  return ['shell', 'input', 'keyevent', buttonKeycode(name)]
}

// RotateOrientation vocab from the emulator RPC (serve-sim's names, shared with
// iOS) mapped to Android user_rotation. left/right handedness is an assumption to
// verify on hardware. Numeric 0..3 is accepted directly.
const ORIENTATION_USER_ROTATION: Record<string, DeviceRotation> = {
  portrait: 0,
  landscape_left: 1,
  portrait_upside_down: 2,
  landscape_right: 3
}

export function orientationToUserRotation(orientation: string): DeviceRotation {
  const key = orientation.trim().toLowerCase()
  if (key in ORIENTATION_USER_ROTATION) {
    return ORIENTATION_USER_ROTATION[key]
  }
  if (/^[0-3]$/.test(key)) {
    return Number(key) as DeviceRotation
  }
  throw new EmulatorError('emulator_error', `Unknown Android orientation '${orientation}'.`)
}

// NOTE: changing user_rotation swaps the display dimensions, so the H.264 stream
// must be re-initialized by the caller (Phase 4) for tap mapping to stay correct.
export function buildRotateArgs(orientation: string): string[] {
  return ['shell', 'settings', 'put', 'system', 'user_rotation', String(orientationToUserRotation(orientation))]
}

// Thin executor layer: prepend the per-call `-s <serial>` to a pure argv. The
// builders stay serial-free so the same argv works for any device.
export function runAdbShellInput(
  executor: AdbCommandExecutor,
  serial: string,
  argv: string[]
): Promise<AdbCommandResult> {
  return executor.exec('adb', ['-s', serial, ...argv])
}
