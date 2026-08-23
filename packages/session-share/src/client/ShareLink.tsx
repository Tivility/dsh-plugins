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
import {
  Button,
  IconCheckOutline16,
  IconLinkOutline16,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge that declares this seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { shareQuery } from '../param.js'
import { SHARE_NS } from './namespace.js'

/** How long the copied state shows, in ms — matched to the harness's own copy controls. */
const COPIED_MS = 1000

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
      icon={copied ? <IconCheckOutline16 size={14} /> : <IconLinkOutline16 size={14} />}
    >
      {copied ? t('copied') : t('copy')}
    </Button>
  )
}
