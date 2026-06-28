import { describe, expect, it } from 'vitest'
import {
  buildButtonArgs,
  buildGestureSwipeArgs,
  buildRotateArgs,
  buildTapArgs,
  buildTypeArgs,
  buttonKeycode,
  orientationToUserRotation,
  sanitizeTypeText,
  type StreamSize
} from './adb-input-control'
import { EmulatorError } from './emulator-errors'

const SIZE: StreamSize = { width: 1080, height: 1920 }

describe('buildTapArgs rotation-aware pixel mapping', () => {
  it('maps the center at rotation 0 (portrait, natural box)', () => {
    expect(buildTapArgs(0.5, 0.5, SIZE, 0)).toEqual(['shell', 'input', 'tap', '540', '960'])
  })

  it('maps the corners at rotation 0', () => {
    expect(buildTapArgs(0, 0, SIZE, 0)).toEqual(['shell', 'input', 'tap', '0', '0'])
    expect(buildTapArgs(1, 1, SIZE, 0)).toEqual(['shell', 'input', 'tap', '1080', '1920'])
  })

  it('swaps width/height for the landscape rotations (1 and 3)', () => {
    expect(buildTapArgs(0.5, 0.5, SIZE, 1)).toEqual(['shell', 'input', 'tap', '960', '540'])
    expect(buildTapArgs(1, 0, SIZE, 3)).toEqual(['shell', 'input', 'tap', '1920', '0'])
  })

  it('keeps the natural box for reverse portrait (rotation 2)', () => {
    expect(buildTapArgs(1, 1, SIZE, 2)).toEqual(['shell', 'input', 'tap', '1080', '1920'])
  })

  it('clamps out-of-range normalized values', () => {
    expect(buildTapArgs(-1, 2, SIZE, 0)).toEqual(['shell', 'input', 'tap', '0', '1920'])
  })
})

describe('buildGestureSwipeArgs segmentation', () => {
  it('emits one discrete swipe per consecutive point pair', () => {
    const points = [
      { type: 'begin' as const, x: 0, y: 0 },
      { type: 'move' as const, x: 0.5, y: 0.5 },
      { type: 'end' as const, x: 1, y: 1 }
    ]
    const swipes = buildGestureSwipeArgs(points, SIZE, 0, 50)
    expect(swipes).toHaveLength(2)
    expect(swipes[0]).toEqual(['shell', 'input', 'swipe', '0', '0', '540', '960', '50'])
    expect(swipes[1]).toEqual(['shell', 'input', 'swipe', '540', '960', '1080', '1920', '50'])
  })

  it('emits a single swipe for a two-point polyline', () => {
    const points = [
      { type: 'begin' as const, x: 0, y: 0 },
      { type: 'end' as const, x: 0.5, y: 0.25 }
    ]
    expect(buildGestureSwipeArgs(points, SIZE, 0)).toHaveLength(1)
  })

  it('downsamples a long polyline to a bounded number of swipes, keeping endpoints', () => {
    const points = Array.from({ length: 64 }, (_, i) => ({
      type: i === 0 ? ('begin' as const) : i === 63 ? ('end' as const) : ('move' as const),
      x: i / 63,
      y: i / 63
    }))
    const swipes = buildGestureSwipeArgs(points, SIZE, 0)
    expect(swipes.length).toBeLessThanOrEqual(8)
    // first swipe starts at the origin, last swipe ends at the far corner.
    expect(swipes[0].slice(3, 5)).toEqual(['0', '0'])
    expect(swipes.at(-1)?.slice(5, 7)).toEqual(['1080', '1920'])
  })
})

describe('type text sanitization', () => {
  it('escapes spaces as %s', () => {
    expect(buildTypeArgs('hello world')).toEqual(['shell', 'input', 'text', 'hello%sworld'])
  })

  it('strips emoji and then escapes spaces', () => {
    expect(sanitizeTypeText('hi 😀')).toBe('hi%s')
    expect(sanitizeTypeText('a😀b')).toBe('ab')
  })

  it('leaves plain ascii untouched', () => {
    expect(sanitizeTypeText('Order66!')).toBe('Order66!')
  })
})

describe('button name to keycode', () => {
  it('maps the documented button names', () => {
    expect(buttonKeycode('home')).toBe('KEYCODE_HOME')
    expect(buttonKeycode('back')).toBe('KEYCODE_BACK')
    expect(buttonKeycode('recent')).toBe('KEYCODE_APP_SWITCH')
    expect(buttonKeycode('recents')).toBe('KEYCODE_APP_SWITCH')
    expect(buttonKeycode('power')).toBe('KEYCODE_POWER')
    expect(buttonKeycode('volume_up')).toBe('KEYCODE_VOLUME_UP')
    expect(buttonKeycode('volume_down')).toBe('KEYCODE_VOLUME_DOWN')
  })

  it('is case-insensitive and passes through raw keycodes', () => {
    expect(buttonKeycode('HOME')).toBe('KEYCODE_HOME')
    expect(buttonKeycode('KEYCODE_CAMERA')).toBe('KEYCODE_CAMERA')
    expect(buttonKeycode('66')).toBe('66')
  })

  it('builds the keyevent argv', () => {
    expect(buildButtonArgs('back')).toEqual(['shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  })

  it('throws on an unknown button name', () => {
    expect(() => buttonKeycode('frobnicate')).toThrow(EmulatorError)
  })
})

describe('rotate orientation to user_rotation', () => {
  it('maps the RPC orientation vocab to user_rotation 0..3', () => {
    expect(orientationToUserRotation('portrait')).toBe(0)
    expect(orientationToUserRotation('landscape_left')).toBe(1)
    expect(orientationToUserRotation('portrait_upside_down')).toBe(2)
    expect(orientationToUserRotation('landscape_right')).toBe(3)
  })

  it('accepts a numeric rotation', () => {
    expect(orientationToUserRotation('2')).toBe(2)
  })

  it('builds the settings put argv', () => {
    expect(buildRotateArgs('landscape_left')).toEqual([
      'shell',
      'settings',
      'put',
      'system',
      'user_rotation',
      '1'
    ])
  })

  it('throws on an unknown orientation', () => {
    expect(() => orientationToUserRotation('sideways')).toThrow(EmulatorError)
  })
})
