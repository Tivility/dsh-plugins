/**
 * The workflow engine half of this package: upstream
 * `@deepseek-ai/dsh-workflow-ptc@0.2.1-alpha.1` with `globalMemory` accepted by
 * agent(). Mount it in place of `@deepseek-ai/dsh-workflow-ptc`.
 * @module @tivility/dsh-tool-workflow-memory/engine
 */

export * from './ptc/index.js'
export { default } from './ptc/index.js'
