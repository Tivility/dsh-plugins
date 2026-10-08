/**
 * Types and schema for per-session working context window and compaction settings.
 *
 * @module @tivility/dsh-compaction-window/types
 */

import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
    sessionProjections: SessionProjectionRegistry
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable compaction settings update or clear for a session. */
    'compaction/settings': {
      settings: SessionCompactionSettings | null
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Session-level compaction settings projection state. */
    'compaction-window': SessionCompactionSettings | null
  }
}

/** Per-session compaction override fields. */
export interface SessionCompactionSettings {
  /** Working context window cap; clamped to model's real window. Positive integer. */
  contextWindow?: number
  /** Fraction of effective window triggering compaction. Number in (0, 1]. */
  thresholdRatio?: number
  /** Verbatim-tail fraction of message budget. Number in (0, 1]. */
  retainRatio?: number
  /** Absolute recent tokens retained. Non-negative integer. */
  retainTokens?: number
  /** Additional pressure headroom beyond reserved output. Non-negative integer. */
  headroomTokens?: number
}

/** Compaction plugin configuration extending basic compaction with default contextWindow. */
export interface CompactionWindowConfig extends BasicCompactionConfig {
  /** Default working context window cap. Clamped to model's real window. Positive integer. */
  contextWindow?: number
}

/** Source indicator for where an effective setting value originated. */
export type SettingSource = 'session' | 'modelPolicy' | 'config' | 'default'

/** Effective compaction settings with source annotations. */
export interface EffectiveCompactionSettings {
  contextWindow: { value: number; source: SettingSource }
  realContextWindow: number
  thresholdRatio: { value: number; source: SettingSource }
  headroomTokens: { value: number; source: SettingSource }
  retainRatio?: { value: number; source: SettingSource }
  retainTokens?: { value: number; source: SettingSource }
  thresholdTokens: number
  effectiveRetainTokens: number
}

/** Compaction window service contract. */
export interface CompactionWindowEngine extends CompactionEngine {
  /** Set session-level compaction overrides. */
  setSessionSettings(session: Session, settings: SessionCompactionSettings): Promise<void>
  /** Clear session-level compaction overrides. */
  clearSessionSettings(session: Session): Promise<void>
  /** Resolve effective settings for a session with source annotations. */
  effectiveSettings(session: Session, signal?: AbortSignal): Promise<EffectiveCompactionSettings>
}
