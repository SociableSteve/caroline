import { readFileSync } from 'node:fs'
import type { z } from 'zod'
import { registerEnvironmentSecrets } from './redact.js'
import {
  credentialFreeUrl,
  fileConfigSchema,
  remoteLlmProviders,
  type Config,
  type FileConfig,
  type LlmProvider,
} from './schema.js'

/** A configuration problem the user has to fix before the process can start. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export interface LoadOptions {
  /** Parsed contents of `caroline.config.json`, or null when there is no file. */
  file: unknown
  env: NodeJS.ProcessEnv
}

/** Secrets never belong in the config file. Each entry names the environment to use instead. */
const secretsBannedFromFile: ReadonlyArray<{ path: string; envHint: string }> = [
  { path: 'llm.apiKey', envHint: 'ANTHROPIC_API_KEY or OPENAI_API_KEY' },
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

function apiKeyFor(provider: LlmProvider, env: NodeJS.ProcessEnv): string | null {
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

function assertContentPolicyIsAllowed(config: Config): void {
  const remote = remoteLlmProviders.includes(config.llm.provider)
  if (
    config.privacy.llmContent === 'full' &&
    remote &&
    !config.privacy.allowFullContentToRemoteProvider
  ) {
    throw new ConfigError(
      `privacy.llmContent is "full" with the remote provider "${config.llm.provider}", which sends complete message bodies to a third party. Set privacy.allowFullContentToRemoteProvider to true to accept that, or lower privacy.llmContent.`,
    )
  }
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
export function loadConfig({ file, env }: LoadOptions): Config {
  rejectSecretsInFile(file)
  const parsed = parseFile(file)

  const provider =
    (nonEmpty(env.CAROLINE_LLM_PROVIDER) as LlmProvider | null) ?? parsed.llm.provider
  if (!['none', 'anthropic', 'openai', 'ollama'].includes(provider)) {
    throw new ConfigError(
      `Invalid configuration. llm.provider: CAROLINE_LLM_PROVIDER must be one of none, anthropic, openai, ollama.`,
    )
  }

  const apiKey = apiKeyFor(provider, env)
  const githubToken = nonEmpty(env.GITHUB_TOKEN)
  const googleClientId = nonEmpty(env.GOOGLE_CLIENT_ID) ?? parsed.integrations.google.clientId
  const googleClientSecret = nonEmpty(env.GOOGLE_CLIENT_SECRET)

  const config: Config = {
    server: {
      host: nonEmpty(env.CAROLINE_HOST) ?? parsed.server.host,
      port: envPort(env, parsed.server.port),
      accessToken: nonEmpty(env.CAROLINE_ACCESS_TOKEN),
    },
    database: {
      path: nonEmpty(env.CAROLINE_DB_PATH) ?? parsed.database.path,
    },
    tasks: parsed.tasks,
    privacy: parsed.privacy,
    llm: {
      provider,
      model: nonEmpty(env.CAROLINE_LLM_MODEL) ?? parsed.llm.model,
      baseUrl: envBaseUrl(env, parsed.llm.baseUrl),
      apiKey,
      isLocal: provider === 'ollama',
      configured: provider === 'ollama' || (provider !== 'none' && apiKey !== null),
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
        configured:
          parsed.integrations.google.enabled &&
          googleClientId !== null &&
          googleClientSecret !== null,
      },
    },
  }

  registerEnvironmentSecrets(config, environmentSecrets(env))

  assertContentPolicyIsAllowed(config)
  assertBindIsSafe(config)

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
