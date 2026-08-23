/**
 * The copy control's behaviour, which cannot be observed from a driven
 * browser: Chrome grants clipboard writes only to a *visible* document, and an
 * automated pane's tab stays `hidden`. So the one rule that matters lives
 * here — a refused write must never be reported as a copy.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const writeClipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>())

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  writeClipboard,
  // Stand-ins for the styled atoms: this suite asserts behaviour, and the real
  // ones drag in the whole stylesheet pipeline.
  Button: ({ icon, children, ...rest }: Record<string, unknown>) => (
    <button type="button" {...rest}>{icon as never}{children as never}</button>
  ),
  IconLinkOutline16: () => <span data-icon="link" />,
  IconCheckOutline16: () => <span data-icon="check" />,
}))

const { ShareLink } = await import('../src/client/ShareLink.tsx')

/** The copy this control renders, as the framework would inject it. */
const t = ((key: string) => ({ copy: 'Copy link', copied: 'Copied', hint: 'Copy a link' })[key]) as never

/** Render the control for one session id. */
function mount(sessionId = 'session-42') {
  render(<ShareLink sessionId={sessionId as never} t={t} {...({} as never)} />)
  return screen.getByRole('button')
}

afterEach(() => {
  cleanup()
  writeClipboard.mockReset()
  vi.useRealTimers()
})

describe('ShareLink', () => {
  it('offers the link for this session, built from the browser own origin', () => {
    writeClipboard.mockResolvedValue(true)
    const button = mount('session-42')
    // window.location.origin under jsdom is http://localhost:3000 by default.
    expect(button.title).toContain(`${window.location.origin}/?session=session-42`)
    expect(button.textContent).toContain('Copy link')
  })

  it('percent-encodes an id that would otherwise break the query', () => {
    writeClipboard.mockResolvedValue(true)
    expect(mount('a b&c').title).toContain('?session=a%20b%26c')
  })

  it('copies that exact link and reports success', async () => {
    writeClipboard.mockResolvedValue(true)
    const button = mount('session-42')
    await act(async () => { button.click() })
    expect(writeClipboard).toHaveBeenCalledWith(`${window.location.origin}/?session=session-42`)
    expect(button.textContent).toContain('Copied')
  })

  it('never claims a copy the host refused', async () => {
    // The case a driven browser always hits: Chrome refuses a clipboard write
    // from a hidden document. Silence is correct; a false "Copied" is not.
    writeClipboard.mockResolvedValue(false)
    const button = mount()
    await act(async () => { button.click() })
    expect(writeClipboard).toHaveBeenCalledOnce()
    expect(button.textContent).toContain('Copy link')
  })

  it('reverts to the idle label after the feedback window', async () => {
    vi.useFakeTimers()
    writeClipboard.mockResolvedValue(true)
    const button = mount()
    await act(async () => { button.click() })
    expect(button.textContent).toContain('Copied')
    await act(async () => { vi.advanceTimersByTime(1100) })
    expect(button.textContent).toContain('Copy link')
  })

  it('ignores repeat clicks while the success state is showing', async () => {
    writeClipboard.mockResolvedValue(true)
    const button = mount()
    await act(async () => { button.click() })
    await act(async () => { button.click() })
    expect(writeClipboard).toHaveBeenCalledOnce()
  })
})
