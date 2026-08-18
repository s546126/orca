import { afterEach, describe, expect, it, vi } from 'vitest'
import { isWebClientLocation } from './web-client-location'

describe('isWebClientLocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('treats the Pake/web bootstrap flag as a web client', () => {
    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: true,
      location: { pathname: '/index.html' }
    })

    expect(isWebClientLocation()).toBe(true)
  })

  it('treats pairing web-index.html as a web client without the flag', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/orca/web-index.html' }
    })

    expect(isWebClientLocation()).toBe(true)
  })

  it('does not treat the Electron renderer index.html as a web client', () => {
    vi.stubGlobal('window', {
      location: { pathname: '/index.html' }
    })

    expect(isWebClientLocation()).toBe(false)
  })
})
