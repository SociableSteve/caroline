/**
 * The one place a provider is chosen. Switching `llm.provider` in the configuration and
 * restarting changes what every caller talks to, with no other change anywhere.
 * Spec 03, criterion 5.
 */
import type { Config, LlmSettings } from '../config/schema.js'
import type { LlmPurpose } from '../domain/llm.js'
import type { Database } from '../db/connection.js'
import { createAnthropicAdapter } from './adapters/anthropic.js'
import { createOllamaAdapter } from './adapters/ollama.js'
import { createOpenAiAdapter } from './adapters/openai.js'
import { createBudgetGate, withBudget } from './budget.js'
import { llmCallRecorder } from './recording.js'
import { withSchemaValidation } from './structured.js'
import { LlmError, type LlmProvider } from './types.js'

export type { LlmProvider } from './types.js'

/** Which settings a purpose runs on. Spec 03 gives classification and chat their own. */
export function settingsFor(config: Config, purpose: LlmPurpose): LlmSettings {
  if (purpose === 'classification') return config.llm.overrides.classification ?? config.llm
  if (purpose === 'chat') return config.llm.overrides.chat ?? config.llm
  return config.llm
}

export interface AdapterOverrides {
  /** Injected in tests so that no adapter reaches the network. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The bare adapter for one set of settings: no validation, no recording. Exported for the
 * adapter tests, which have to be able to see exactly what one provider returned.
 */
export function createAdapter(
  settings: LlmSettings,
  { fetch }: AdapterOverrides = {},
): LlmProvider {
  // Provider first, then model: "nothing is set up" is the more useful thing to be told
  // than "your nonexistent provider has no model".
  if (settings.provider === 'none') {
    throw new LlmError('No LLM provider is configured. Set llm.provider to use this feature.')
  }
  if (settings.model === null) {
    throw new LlmError(`No model is configured for the provider "${settings.provider}".`)
  }

  const options = {
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    supportsTools: settings.supportsTools,
    ...(fetch === undefined ? {} : { fetch }),
  }

  switch (settings.provider) {
    case 'anthropic':
      return createAnthropicAdapter(options)
    case 'openai':
      return createOpenAiAdapter(options)
    case 'ollama':
      return createOllamaAdapter(options)
  }
}

export interface LlmRuntime {
  /**
   * The provider for a purpose: the configured adapter, with the validate-and-retry rule
   * around it and every attempt recorded. Throws when nothing is configured, so a caller
   * asks `isConfigured` first rather than receiving something that fails at the call.
   */
  for(purpose: LlmPurpose): LlmProvider
  isConfigured(purpose: LlmPurpose): boolean
  /**
   * Null when a call for this purpose is within its provider's spending ceiling, otherwise the
   * reason it is not, in words the person paying can act on. Asked before the call, so that a job
   * can skip and chat can answer rather than either of them catching an exception. Spec 03,
   * criteria 13 and 14.
   */
  budgetRefusal(purpose: LlmPurpose): string | null
}

export interface LlmRuntimeOptions extends AdapterOverrides {
  readonly config: Config
  /** Where `llm_calls` rows go. Omitted, calls are made but not recorded. */
  readonly database?: Database
  readonly now?: () => number
  /** Told when a usage row could not be written, which never fails the call itself. */
  readonly onRecordingError?: (error: unknown) => void
}

export function createLlmRuntime({
  config,
  database,
  now,
  fetch,
  onRecordingError,
}: LlmRuntimeOptions): LlmRuntime {
  // Built once per purpose and kept: an adapter holds an SDK client with its own connection
  // pool, and a fresh one per call would throw that away every time.
  const built = new Map<LlmPurpose, LlmProvider>()
  const gate = createBudgetGate({ config, database, now })

  /** The ceiling is per provider, and a purpose's provider is whatever its settings name. */
  function refusalFor(purpose: LlmPurpose): string | null {
    const { provider } = settingsFor(config, purpose)
    return provider === 'none' ? null : gate.refusalFor(provider)
  }

  return {
    isConfigured(purpose) {
      return settingsFor(config, purpose).configured
    },

    budgetRefusal: refusalFor,

    for(purpose) {
      const existing = built.get(purpose)
      if (existing !== undefined) return existing

      const adapter = createAdapter(settingsFor(config, purpose), {
        ...(fetch === undefined ? {} : { fetch }),
      })

      // The ceiling is checked outside the validate-and-retry loop, so a refusal is not an attempt:
      // it spends no tokens and writes no `llm_calls` row. Spec 03, criterion 11.
      const provider = withBudget(
        withSchemaValidation(adapter, {
          ...(database === undefined
            ? {}
            : { onAttempt: llmCallRecorder(database, adapter, purpose, onRecordingError) }),
          ...(now === undefined ? {} : { now }),
        }),
        () => refusalFor(purpose),
      )

      built.set(purpose, provider)
      return provider
    },
  }
}
