/**
 * Session projection definition and event application for compaction settings.
 *
 * @module @tivility/dsh-compaction-window/projection
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionCompactionSettings } from './types.js'

export const sessionCompactionSettingsSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  thresholdRatio: z.number().min(0, { message: 'thresholdRatio must be > 0' }).max(1).refine(v => v > 0, { message: 'thresholdRatio must be > 0' }).optional(),
  retainRatio: z.number().min(0, { message: 'retainRatio must be > 0' }).max(1).refine(v => v > 0, { message: 'retainRatio must be > 0' }).optional(),
  retainTokens: z.number().int().nonnegative().optional(),
  headroomTokens: z.number().int().nonnegative().optional(),
}).refine(data => !(data.retainRatio !== undefined && data.retainTokens !== undefined), {
  message: 'retainRatio and retainTokens are mutually exclusive',
})

const stateSchema = z.union([sessionCompactionSettingsSchema, z.null()])

/** Apply function for compaction settings projection. */
export function applyCompactionSettingsEvent(
  state: SessionCompactionSettings | null,
  event: SessionEvent,
): SessionCompactionSettings | null {
  if (event.type === 'compaction/settings') {
    return (event.data as { settings: SessionCompactionSettings | null }).settings
  }
  return state
}

/** Session projection definition for compaction settings. */
export const compactionWindowProjectionDefinition = {
  key: 'compaction-window',
  stateVersion: 1,
  stateSchema: stateSchema as unknown as z.ZodType<SessionCompactionSettings | null>,
  init: () => null,
  apply: applyCompactionSettingsEvent,
} satisfies ProjectionDefinition<'compaction-window', SessionCompactionSettings | null>
