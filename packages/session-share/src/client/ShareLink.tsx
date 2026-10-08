/**
 * The session header's "copy link" control.
 *
 * Without it the feature is unreachable by a person: the link format lives in
 * the system prompt, which teaches the *model* to hand out links, and leaves
 * whoever is looking at the GUI to construct one from a session id they cannot
 * see. This is the one affordance that makes it a feature rather than a
 * convention.
 *
 * The origin comes from `window.location`, so the link is always the address
 * this browser reached the harness at — the loopback URL when that is how you
 * opened it, the LAN address when it is not. Nothing to configure, and nothing
 * that can drift from where the server actually answers.
 * @module @tivility/dsh-session-share/client/ShareLink
 */

import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge that declares this seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { shareQuery } from '../param.js'
import { SHARE_NS } from './namespace.js'

/** How long the copied state shows, in ms — matched to the harness's own copy controls. */
const COPIED_MS = 1000

const { Button, writeClipboard } = Primitives

/** One icon component, as both generations of the host primitives declare it. */
export type IconComponent = (props: { size?: number }) => ReactElement | null

/** The fallback for a host that exports none of the requested names. */
const NoIcon: IconComponent = () => null

/**
 * Pick the first icon a host's primitives export under any of `names`.
 *
 * The primitives package is not bundled: the page's loader hands this plugin
 * whatever release the host is running. dsh 0.1.7 renamed the fixed-size
 * `…Outline16` icons to weight-suffixed `…OutlineRegular` ones, so a static
 * import resolves to `undefined` on one side of that release and crashes the
 * header slot. Looking the names up at run time keeps one build working on
 * both; a host exporting neither gets no glyph rather than a broken header.
 * @param exports - the primitives module's export table.
 * @param names - candidate export names, newest first.
 * @returns the first function export found, or a component that renders nothing.
 */
export function resolveIcon(exports: Readonly<Record<string, unknown>>, ...names: readonly string[]): IconComponent {
  for (const name of names) {
    const candidate = exports[name]
    if (typeof candidate === 'function') return candidate as IconComponent
  }
  return NoIcon
}

const primitiveExports = Primitives as unknown as Readonly<Record<string, unknown>>
const IconCheck = resolveIcon(primitiveExports, 'IconCheckOutlineRegular', 'IconCheckOutline16')
const IconLink = resolveIcon(primitiveExports, 'IconLinkOutlineRegular', 'IconLinkOutline16')

/** Full component props: the framework's session context plus this bundle's copy. */
export type ShareLinkProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof SHARE_NS>

/**
 * Render the copy-link control for the current session.
 * @param props - composed slot props.
 * @returns the control.
 */
export function ShareLink({ sessionId, t }: ShareLinkProps) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/${shareQuery(String(sessionId))}`

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(url).then((accepted) => {
      // A refused write (denied permission, insecure context) leaves the flag
      // alone: the control must never claim a copy the host declined.
      if (!accepted) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, COPIED_MS)
    })
  }, [copied, url])

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onCopy}
      // The URL itself is the most useful hover text: it is what gets copied,
      // and seeing it is how someone learns the format exists.
      title={copied ? t('copied') : `${t('hint')}\n${url}`}
      icon={copied ? <IconCheck size={14} /> : <IconLink size={14} />}
    >
      {copied ? t('copied') : t('copy')}
    </Button>
  )
}
