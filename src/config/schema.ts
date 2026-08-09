import { z } from 'zod'

/**
 * Content policy levels, ordered from least to most exposure. Spec 09.
 */
export const contentLevels = ['none', 'metadata', 'snippet', 'full'] as const
export type ContentLevel = (typeof contentLevels)[number]

export const contentLevelRank: Record<ContentLevel, number> = {
  none: 0,
  metadata: 1,
  snippet: 2,
  full: 3,
}

export const llmProviders = ['none', 'anthropic', 'openai', 'ollama'] as const
export type LlmProvider = (typeof llmProviders)[number]

/** Providers that send content off this machine. Spec 09 guards `full` content for these. */
export const remoteLlmProviders: readonly LlmProvider[] = ['anthropic', 'openai']

/**
 * A URL with no user info in it. `baseUrl` is not a secret field, so it is returned
 * verbatim by `GET /api/config` and is not scrubbed from logs. Credentials embedded in it
 * would therefore leak, so they are rejected outright rather than quietly redacted. Both
 * the config file and `CAROLINE_LLM_BASE_URL` are checked against this. Spec 09.
 */
export const credentialFreeUrl = z
  .string()
  .url('must be a valid URL')
  .refine((value) => {
    // Zod still runs a refinement after `url()` has failed, so an unparseable value has to
    // pass through here and be reported by that check rather than throwing.
    if (!URL.canParse(value)) return true

    const { username, password } = new URL(value)
    return username === '' && password === ''
  }, 'must not embed credentials: set the API key in the environment instead')

/**
 * The configuration as it may be written in `caroline.config.json`. Secrets are absent by
 * design: they only ever come from the environment, and their presence here is a startup
 * error rather than a silently accepted value.
 */
export const fileConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65535).default(5123),
      })
      .strict()
      .default({}),
    database: z
      .object({
        path: z.string().min(1).default('./data/caroline.db'),
      })
      .strict()
      .default({}),
    tasks: z
      .object({
        /**
         * How long a `waiting` item may sit before it is called out as stale, in the column,
         * on the dashboard and in the daily plan. Spec 02 sets the default at seven days.
         */
        waitingStaleDays: z.number().int().min(1).max(365).default(7),
      })
      .strict()
      .default({}),
    privacy: z
      .object({
        llmContent: z.enum(contentLevels).default('snippet'),
        storeContent: z.enum(contentLevels).default('metadata'),
        snippetChars: z.number().int().min(0).max(10000).default(300),
        retainContentDays: z.number().int().min(1).max(3650).default(30),
        allowFullContentToRemoteProvider: z.boolean().default(false),
      })
      .strict()
      .default({}),
    llm: z
      .object({
        provider: z.enum(llmProviders).default('none'),
        model: z.string().min(1).nullable().default(null),
        baseUrl: credentialFreeUrl.nullable().default(null),
      })
      .strict()
      .default({}),
    integrations: z
      .object({
        github: z
          .object({
            enabled: z.boolean().default(true),
            /**
             * Whether new commits after a changes-requested review pull a pull request back
             * into Review, or only an explicit re-request does. Spec 02 defaults it on: if
             * you asked for changes, the changes arriving are your cue.
             */
            returnToReviewOnNewCommits: z.boolean().default(true),
          })
          .strict()
          .default({}),
        google: z
          .object({
            enabled: z.boolean().default(true),
            clientId: z.string().min(1).nullable().default(null),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict()

export type FileConfig = z.infer<typeof fileConfigSchema>

/**
 * The effective configuration the rest of the process reads: the validated file config
 * plus the secrets from the environment and the derived "is this usable yet" flags.
 */
export interface Config {
  readonly server: {
    readonly host: string
    readonly port: number
    readonly accessToken: string | null
  }
  readonly database: {
    readonly path: string
  }
  readonly tasks: {
    readonly waitingStaleDays: number
  }
  readonly privacy: {
    readonly llmContent: ContentLevel
    readonly storeContent: ContentLevel
    readonly snippetChars: number
    readonly retainContentDays: number
    readonly allowFullContentToRemoteProvider: boolean
  }
  readonly llm: {
    readonly provider: LlmProvider
    readonly model: string | null
    readonly baseUrl: string | null
    readonly apiKey: string | null
    readonly isLocal: boolean
    readonly configured: boolean
  }
  readonly integrations: {
    readonly github: {
      readonly enabled: boolean
      readonly returnToReviewOnNewCommits: boolean
      readonly token: string | null
      readonly configured: boolean
    }
    readonly google: {
      readonly enabled: boolean
      readonly clientId: string | null
      readonly clientSecret: string | null
      readonly configured: boolean
    }
  }
}

/**
 * Every path in the effective config that holds a secret. Redaction and the log scrubber
 * both read this list, so adding a secret in one place covers both.
 */
export const secretPaths = [
  ['server', 'accessToken'],
  ['llm', 'apiKey'],
  ['integrations', 'github', 'token'],
  ['integrations', 'google', 'clientSecret'],
] as const satisfies readonly (readonly string[])[]
