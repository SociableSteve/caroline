import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { createLlmRuntime, settingsFor } from '../../src/llm/index.js'
import { listLlmCalls } from '../../src/db/repositories/llm-calls.js'
import { LlmSchemaError } from '../../src/llm/types.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import {
  classificationSchema,
  expectedClassification,
  recordedPayload,
  stubFetch,
} from '../helpers/llm.js'

const noEnv = {} as NodeJS.ProcessEnv

const request = {
  system: 'Sort this item.',
  messages: [{ role: 'user' as const, content: 'Can you sign off the venue booking?' }],
  schema: classificationSchema,
  maxTokens: 512,
}

/** Spec 03, criterion 5. */
describe('choosing a provider from the configuration', () => {
  it.each([
    ['anthropic', 'anthropic-classification', { ANTHROPIC_API_KEY: 'sk-ant' }],
    ['openai', 'openai-classification', { OPENAI_API_KEY: 'sk-oai' }],
    ['ollama', 'ollama-classification', {}],
  ] as const)(
    'uses %s when the config names it, with no other change',
    async (provider, fixture, env) => {
      const config = loadConfig({
        file: { llm: { provider, model: 'a-model' } },
        env: env as NodeJS.ProcessEnv,
      })
      const stub = stubFetch([{ body: recordedPayload(fixture) }])

      const runtime = createLlmRuntime({ config, fetch: stub.fetch })
      const result = await runtime.for('classification').complete(request)

      expect(runtime.for('classification').name).toBe(provider)
      expect(result.structured).toEqual(expectedClassification)
    },
  )

  it('reports nothing configured when no provider is set', () => {
    const runtime = createLlmRuntime({ config: loadConfig({ file: null, env: noEnv }) })

    expect(runtime.isConfigured('classification')).toBe(false)
    expect(() => runtime.for('classification')).toThrow(/No LLM provider is configured/)
  })

  it('reports nothing configured when a provider is named but its key is not set', () => {
    const config = loadConfig({
      file: { llm: { provider: 'anthropic', model: 'a-model' } },
      env: noEnv,
    })

    expect(createLlmRuntime({ config }).isConfigured('classification')).toBe(false)
  })
})

describe('per-job overrides', () => {
  const config = loadConfig({
    file: {
      llm: {
        provider: 'anthropic',
        model: 'the-strong-one',
        maxTokens: 4096,
        overrides: { classification: { model: 'the-cheap-one', maxTokens: 512 } },
      },
    },
    env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
  })

  it('gives classification the model it names', () => {
    expect(settingsFor(config, 'classification').model).toBe('the-cheap-one')
    expect(settingsFor(config, 'classification').maxTokens).toBe(512)
  })

  it('leaves the purposes with no override on the base settings', () => {
    expect(settingsFor(config, 'chat').model).toBe('the-strong-one')
    expect(settingsFor(config, 'planning').model).toBe('the-strong-one')
  })

  it('keeps what the override did not mention, including the key', () => {
    expect(settingsFor(config, 'classification').provider).toBe('anthropic')
    expect(settingsFor(config, 'classification').apiKey).toBe('sk-ant')
  })

  it('resolves the key of the provider an override names, not of the base one', () => {
    const mixed = loadConfig({
      file: {
        llm: {
          provider: 'ollama',
          model: 'llama',
          overrides: { chat: { provider: 'anthropic', model: 'claude' } },
        },
      },
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
    })

    expect(settingsFor(mixed, 'chat').apiKey).toBe('sk-ant')
    expect(settingsFor(mixed, 'chat').isLocal).toBe(false)
    expect(settingsFor(mixed, 'planning').apiKey).toBeNull()
  })

  it('does not carry a base URL across a change of provider', () => {
    const mixed = loadConfig({
      file: {
        llm: {
          provider: 'ollama',
          model: 'llama',
          baseUrl: 'http://127.0.0.1:11434',
          overrides: { chat: { provider: 'anthropic', model: 'claude' } },
        },
      },
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
    })

    expect(settingsFor(mixed, 'chat').baseUrl).toBeNull()
    expect(settingsFor(mixed, 'planning').baseUrl).toBe('http://127.0.0.1:11434')
  })
})

/** Spec 03, criterion 7. */
describe('recording what every call cost', () => {
  const config = loadConfig({
    file: { llm: { provider: 'ollama', model: 'llama-recorded' } },
    env: noEnv,
  })

  it('records a successful call with the usage the provider stated', async () => {
    const database = migratedDatabase()
    const stub = stubFetch([{ body: recordedPayload('ollama-classification') }])

    await createLlmRuntime({ config, database, fetch: stub.fetch })
      .for('classification')
      .complete(request)

    expect(listLlmCalls(database)).toMatchObject([
      {
        provider: 'ollama',
        model: 'llama-recorded',
        purpose: 'classification',
        status: 'success',
        inputTokens: 412,
        outputTokens: 37,
      },
    ])
  })

  it('records the answer that failed validation as well as the retry that worked', async () => {
    const database = migratedDatabase()
    const rejected = recordedPayload('ollama-classification') as Record<string, unknown>
    const stub = stubFetch([
      { body: { ...rejected, message: { role: 'assistant', content: '{"status":"somewhere"}' } } },
      { body: recordedPayload('ollama-classification') },
    ])

    await createLlmRuntime({ config, database, fetch: stub.fetch })
      .for('classification')
      .complete(request)

    const calls = listLlmCalls(database)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.status).sort()).toEqual(['invalid', 'success'])
    // The tokens of the answer that did not fit were spent just the same.
    expect(calls.every((call) => call.inputTokens === 412)).toBe(true)
  })

  it('records both failures when neither answer validates, and still refuses the output', async () => {
    const database = migratedDatabase()
    const rejected = recordedPayload('ollama-classification') as Record<string, unknown>
    const stub = stubFetch([
      { body: { ...rejected, message: { role: 'assistant', content: '{"status":"somewhere"}' } } },
    ])

    const runtime = createLlmRuntime({ config, database, fetch: stub.fetch })

    await expect(runtime.for('classification').complete(request)).rejects.toThrow(LlmSchemaError)
    expect(listLlmCalls(database).map((call) => call.status)).toEqual(['invalid', 'invalid'])
  })

  it('records a call that never came back, which spent nothing but still happened', async () => {
    const database = migratedDatabase()
    const stub = stubFetch([{ status: 500, body: { error: 'model not loaded' } }])

    const runtime = createLlmRuntime({ config, database, fetch: stub.fetch })

    await expect(runtime.for('classification').complete(request)).rejects.toThrow(/500/)
    expect(listLlmCalls(database)).toMatchObject([
      { status: 'error', inputTokens: 0, outputTokens: 0, error: expect.stringContaining('500') },
    ])
  })

  it('tags the call with what it was for', async () => {
    const database = migratedDatabase()
    const stub = stubFetch([{ body: recordedPayload('ollama-classification') }])

    await createLlmRuntime({ config, database, fetch: stub.fetch })
      .for('planning')
      .complete(request)

    expect(listLlmCalls(database)[0]?.purpose).toBe('planning')
  })

  /**
   * Recording is bookkeeping. Losing a whole mailbox's classification because the cost table
   * would not take a row is the wrong trade, so the write is allowed to fail quietly and the
   * failure is reported out of band.
   */
  it('completes the call even when the usage row cannot be written', async () => {
    const database = migratedDatabase()
    database.exec('drop table llm_calls')
    const stub = stubFetch([{ body: recordedPayload('ollama-classification') }])
    const reported: unknown[] = []

    const result = await createLlmRuntime({
      config,
      database,
      fetch: stub.fetch,
      onRecordingError: (error) => reported.push(error),
    })
      .for('classification')
      .complete(request)

    expect(result.structured).toEqual(expectedClassification)
    expect(reported).toHaveLength(1)
    expect(String(reported[0])).toMatch(/llm_calls/)
  })

  it('makes the call even with nowhere to record it', async () => {
    const stub = stubFetch([{ body: recordedPayload('ollama-classification') }])

    const result = await createLlmRuntime({ config, fetch: stub.fetch })
      .for('classification')
      .complete(request)

    expect(result.structured).toEqual(expectedClassification)
  })
})
