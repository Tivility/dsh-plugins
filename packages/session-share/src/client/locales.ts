/** Copy for the session-header share control. */

/** Locale keys this surface renders. */
export type ShareKey = 'copy' | 'copied' | 'hint'

/** English copy. */
export const en: Record<ShareKey, string> = {
  copy: 'Copy link',
  copied: 'Copied',
  hint: 'Copy a link that opens this session',
}

/** Chinese copy. */
export const zh: Record<ShareKey, string> = {
  copy: '复制链接',
  copied: '已复制',
  hint: '复制一个直接打开这条会话的链接',
}
