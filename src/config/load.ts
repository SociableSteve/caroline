import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import type { z } from 'zod'
import { registerEnvironmentSecrets } from './redact.js'
import {
  credentialFreeUrl,
  fileConfigSchema,
  remoteLlmProviders,
  type Config,
  type FileConfig,
  type LlmProviderName,
  type LlmSettings,
} from './schema.js'

/** A configuration problem the user has to fix before the process can start. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export interface LoadOptions {
  /** Parsed contents of `caroline.config.json`, or null when there is no file. */
  file: unknown
  env: NodeJS.ProcessEnv
  /**
   * Whether to enforce the two checks that are about running rather than about the configuration
   * being well formed: that a non-loopback bind has an access token, and that full content is not
   * sent to a remote provider unless that was said out loud. True for the server, which is what
   * they protect.
   *
   * The deletion command reads this configuration to find out where the data is and then starts no
   * server and calls no provider. Refusing to delete somebody's data until they have fixed a content
   * policy would be a refusal to answer the question they asked, and the setup guide's own
   * troubleshooting table sends people here holding exactly that error. Everything else still
   * applies: the schema, the ban on secrets in the file, and every default.
   */
  runtimeChecks?: boolean
}

/** Secrets never belong in the config file. Each entry names the environment to use instead. */
const secretsBannedFromFile: ReadonlyArray<{ path: string; envHint: string }> = [
  { path: 'llm.apiKey', envHint: 'ANTHROPIC_API_KEY or OPENAI_API_KEY' },
  { path: 'llm.overrides.classification.apiKey', envHint: 'ANTHROPIC_API_KEY or OPENAI_API_KEY' },
  { path: 'llm.overrides.chat.apiKey', envHint: 'ANTHROPIC_API_KEY or OPENAI_API_KEY' },
  { path: 'integrations.github.token', envHint: 'GITHUB_TOKEN' },
  { path: 'integrations.google.clientSecret', envHint: 'GOOGLE_CLIENT_SECRET' },
  { path: 'server.accessToken', envHint: 'CAROLINE_ACCESS_TOKEN' },
]

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'])

function valueAtPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, source)
}

function rejectSecretsInFile(file: unknown): void {
  if (file === null || typeof file !== 'object') return

  for (const { path, envHint } of secretsBannedFromFile) {
    if (valueAtPath(file, path) !== undefined) {
      throw new ConfigError(
        `${path} must not appear in caroline.config.json. Secrets are read from the environment only: set ${envHint} instead.`,
      )
    }
  }
}

function parseFile(file: unknown): FileConfig {
  const result = fileConfigSchema.safeParse(file ?? {})
  if (result.success) return result.data

  const detail = result.error.issues
    .map((issue: z.ZodIssue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  throw new ConfigError(`Invalid configuration. ${detail}`)
}

function envPort(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.CAROLINE_PORT
  if (raw === undefined || raw === '') return fallback

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `Invalid configuration. server.port: CAROLINE_PORT must be an integer between 1 and 65535, got "${raw}".`,
    )
  }
  return port
}

/**
 * The environment overrides the file, so it has to meet the same bar the schema sets:
 * without this check `CAROLINE_LLM_BASE_URL` would be the one way credentials could reach
 * an unredacted config field.
 */
function envBaseUrl(env: NodeJS.ProcessEnv, fallback: string | null): string | null {
  const raw = env.CAROLINE_LLM_BASE_URL
  if (raw === undefined || raw === '') return fallback

  const result = credentialFreeUrl.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration. llm.baseUrl: CAROLINE_LLM_BASE_URL ${result.error.issues[0]?.message ?? 'is invalid'}.`,
    )
  }
  return result.data
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

function apiKeyFor(provider: LlmProviderName, env: NodeJS.ProcessEnv): string | null {
  switch (provider) {
    case 'anthropic':
      return nonEmpty(env.ANTHROPIC_API_KEY)
    case 'openai':
      return nonEmpty(env.OPENAI_API_KEY)
    case 'ollama':
    case 'none':
      return null
  }
}

/**
 * The settings a caller chooses, with the derived ones left to `llmSettings`. `supportsTools`
 * is optional here rather than derived, because "not stated" and "stated as false" are
 * different answers and only the first of them follows from the provider.
 */
type LlmChoices = Omit<LlmSettings, 'apiKey' | 'isLocal' | 'configured' | 'supportsTools'> & {
  readonly supportsTools?: boolean | undefined
}

/**
 * The derived facts, in one place, so the base settings and every override agree on what
 * "configured" and "local" mean. Ollama needs no key, so it counts as configured on the
 * strength of a provider and a model alone.
 */
function llmSettings(choices: LlmChoices, env: NodeJS.ProcessEnv): LlmSettings {
  const apiKey = apiKeyFor(choices.provider, env)

  return {
    ...choices,
    apiKey,
    // The hosted providers take tools from every model they serve. Ollama's answer is the
    // model's, not the server's, so it is false until the operator says otherwise: chat that
    // says it cannot make changes is recoverable, and chat that claims changes it could not
    // make is not. Spec 03's graceful degradation, spec 07 criterion 7.
    supportsTools: choices.supportsTools ?? choices.provider !== 'ollama',
    isLocal: choices.provider === 'ollama',
    // A provider with no model named can no more make a call than one with no key, so it is
    // reported the same way: not configured yet, rather than configured and broken.
    configured:
      choices.model !== null &&
      (choices.provider === 'ollama' || (choices.provider !== 'none' && apiKey !== null)),
  }
}

/**
 * An override is a patch on the base settings, not a replacement: naming only a model keeps
 * the base provider, its base URL and its budgets. `undefined` means "not overridden", which
 * is why `model` and `baseUrl` are read with `in` rather than with `??`: both are nullable,
 * and an override deliberately clearing one back to null is a different thing to say than
 * leaving it alone.
 *
 * The one field that is not inherited across a change of provider is the base URL, because
 * it addresses a particular provider's API. An Ollama address handed to the Anthropic
 * adapter is not a proxy, it is a wrong answer, and a silent one.
 */
function overrideSettings(
  base: LlmSettings,
  override: FileConfig['llm']['overrides']['classification'],
  env: NodeJS.ProcessEnv,
): LlmSettings | null {
  if (override === undefined) return null

  const provider = override.provider ?? base.provider
  const inheritedBaseUrl = provider === base.provider ? base.baseUrl : null

  return llmSettings(
    {
      provider,
      model: 'model' in override ? (override.model ?? null) : base.model,
      baseUrl: 'baseUrl' in override ? (override.baseUrl ?? null) : inheritedBaseUrl,
      maxTokens: override.maxTokens ?? base.maxTokens,
      timeoutMs: override.timeoutMs ?? base.timeoutMs,
      // Not inherited across a change of provider, for the same reason as the base URL: it is
      // a fact about a model, and the override has named a different one.
      ...(override.supportsTools === undefined
        ? provider === base.provider
          ? { supportsTools: base.supportsTools }
          : {}
        : { supportsTools: override.supportsTools }),
    },
    env,
  )
}

/** Environment variables that carry a secret, whether or not this configuration uses them. */
const secretEnvVars = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GOOGLE_CLIENT_SECRET',
  'CAROLINE_ACCESS_TOKEN',
] as const

function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return secretEnvVars
    .map((name) => env[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/** The base settings and every configured override, each with the path that named it. */
function everyLlmSettings(config: Config): ReadonlyArray<{ path: string; settings: LlmSettings }> {
  const found: Array<{ path: string; settings: LlmSettings }> = [
    { path: 'llm', settings: config.llm },
  ]

  for (const purpose of ['classification', 'chat'] as const) {
    const settings = config.llm.overrides[purpose]
    if (settings !== null) found.push({ path: `llm.overrides.${purpose}`, settings })
  }

  return found
}

/**
 * Checked against every configured provider, not only the base one: an override may name a
 * hosted provider where the base names ollama, and content sent under that override leaves
 * the machine just the same. Spec 09, criterion 2.
 */
function assertContentPolicyIsAllowed(config: Config): void {
  if (
    config.privacy.llmContent !== 'full' ||
    config.privacy.allowFullContentToRemoteProvider === true
  ) {
    return
  }

  for (const { path, settings } of everyLlmSettings(config)) {
    if (remoteLlmProviders.includes(settings.provider)) {
      throw new ConfigError(
        `privacy.llmContent is "full" with the remote provider "${settings.provider}" at ${path}.provider, which sends complete message bodies to a third party. Set privacy.allowFullContentToRemoteProvider to true to accept that, or lower privacy.llmContent.`,
      )
    }
  }
}

/**
 * Where the Google tokens live: beside the database, absolute, so that nothing depends on the
 * process's working directory at the moment a refresh happens. Not configurable, because spec
 * 09's deletion command should have one directory to remove and not a list.
 */
export function googleTokenPath(databasePath: string): string {
  return resolvePath(dirname(databasePath), 'google-tokens.json')
}

function assertBindIsSafe(config: Config): void {
  if (!loopbackHosts.has(config.server.host) && config.server.accessToken === null) {
    throw new ConfigError(
      `server.host is "${config.server.host}", which is not loopback, and the UI has no login. Set an access token in CAROLINE_ACCESS_TOKEN, or bind to 127.0.0.1.`,
    )
  }
}

/**
 * Defaults in code, overridden by the config file, overridden by the environment. Secrets
 * only ever from the environment. Fails fast with the offending path named. Spec 09.
 */
export function loadConfig({ file, env, runtimeChecks = true }: LoadOptions): Config {
  rejectSecretsInFile(file)
  const parsed = parseFile(file)

  const provider =
    (nonEmpty(env.CAROLINE_LLM_PROVIDER) as LlmProviderName | null) ?? parsed.llm.provider
  if (!['none', 'anthropic', 'openai', 'ollama'].includes(provider)) {
    throw new ConfigError(
      `Invalid configuration. llm.provider: CAROLINE_LLM_PROVIDER must be one of none, anthropic, openai, ollama.`,
    )
  }

  const base: LlmSettings = llmSettings(
    {
      provider,
      model: nonEmpty(env.CAROLINE_LLM_MODEL) ?? parsed.llm.model,
      baseUrl: envBaseUrl(env, parsed.llm.baseUrl),
      maxTokens: parsed.llm.maxTokens,
      timeoutMs: parsed.llm.timeoutMs,
      ...(parsed.llm.supportsTools === undefined
        ? {}
        : { supportsTools: parsed.llm.supportsTools }),
    },
    env,
  )

  const githubToken = nonEmpty(env.GITHUB_TOKEN)
  const googleClientId = nonEmpty(env.GOOGLE_CLIENT_ID) ?? parsed.integrations.google.clientId
  const googleClientSecret = nonEmpty(env.GOOGLE_CLIENT_SECRET)

  const databasePath = nonEmpty(env.CAROLINE_DB_PATH) ?? parsed.database.path

  const config: Config = {
    server: {
      host: nonEmpty(env.CAROLINE_HOST) ?? parsed.server.host,
      port: envPort(env, parsed.server.port),
      accessToken: nonEmpty(env.CAROLINE_ACCESS_TOKEN),
    },
    database: {
      path: databasePath,
    },
    tasks: parsed.tasks,
    jobs: parsed.jobs,
    classification: parsed.classification,
    chat: parsed.chat,
    planning: parsed.planning,
    privacy: parsed.privacy,
    llm: {
      ...base,
      overrides: {
        classification: overrideSettings(base, parsed.llm.overrides.classification, env),
        chat: overrideSettings(base, parsed.llm.overrides.chat, env),
      },
    },
    integrations: {
      github: {
        enabled: parsed.integrations.github.enabled,
        returnToReviewOnNewCommits: parsed.integrations.github.returnToReviewOnNewCommits,
        token: githubToken,
        configured: parsed.integrations.github.enabled && githubToken !== null,
      },
      google: {
        enabled: parsed.integrations.google.enabled,
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        gmailQuery: parsed.integrations.google.gmailQuery,
        calendarIds: parsed.integrations.google.calendarIds,
        calendarLookbackDays: parsed.integrations.google.calendarLookbackDays,
        calendarLookaheadDays: parsed.integrations.google.calendarLookaheadDays,
        tokenPath: googleTokenPath(databasePath),
        configured:
          parsed.integrations.google.enabled &&
          googleClientId !== null &&
          googleClientSecret !== null,
      },
    },
  }

  registerEnvironmentSecrets(config, environmentSecrets(env))

  if (runtimeChecks) {
    assertContentPolicyIsAllowed(config)
    assertBindIsSafe(config)
  }

  return config
}

/** Reads `caroline.config.json` if it is there. A missing file is the normal case. */
export function readConfigFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) {
      throw new ConfigError(`${path} is not valid JSON: ${error.message}`)
    }
    throw error
  }
}
