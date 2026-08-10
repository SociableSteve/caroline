import { z } from 'zod'
import { contentLevelRank, contentLevels, type ContentLevel } from '../domain/content.js'
import { isValidCron, isValidTimeZone } from '../domain/cron.js'

/**
 * The content policy vocabulary is the domain's, and is re-exported here because this is where
 * the rest of the process reads its configuration from. Spec 09.
 */
export { contentLevels, contentLevelRank, type ContentLevel }

export const llmProviders = ['none', 'anthropic', 'openai', 'ollama'] as const
/**
 * Which provider is configured, not the provider itself. `src/llm/types.ts` owns the
 * interface that has the shorter name, and the two appear together often enough that
 * leaving both as `LlmProvider` would make every import site ambiguous.
 */
export type LlmProviderName = (typeof llmProviders)[number]

/** Providers that send content off this machine. Spec 09 guards `full` content for these. */
export const remoteLlmProviders: readonly LlmProviderName[] = ['anthropic', 'openai']

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
 * The bounds on the LLM settings, declared once. The base config and a per-job override
 * accept the same field twice over, and a bound tightened in one place only would leave an
 * override able to ask for something the base config would have refused.
 */
const llmField = {
  provider: () => z.enum(llmProviders),
  model: () => z.string().min(1).nullable(),
  baseUrl: () => credentialFreeUrl.nullable(),
  maxTokens: () => z.number().int().min(1).max(200_000),
  timeoutMs: () => z.number().int().min(1_000).max(600_000),
}

/**
 * What a job may vary from the base LLM settings. Spec 03: a cheap fast model for hourly
 * sorting and a stronger one for chat is the expected setup. `apiKey` is absent by design,
 * as everywhere else in the file config: it follows from the provider and the environment.
 *
 * Every field is optional rather than defaulted, because absent has to stay distinguishable
 * from set: an override that says nothing about a field inherits it, and one that names it
 * does not.
 */
const llmOverrideSchema = z
  .object({
    provider: llmField.provider().optional(),
    model: llmField.model().optional(),
    baseUrl: llmField.baseUrl().optional(),
    maxTokens: llmField.maxTokens().optional(),
    timeoutMs: llmField.timeoutMs().optional(),
  })
  .strict()

const cronExpression = z.string().refine(isValidCron, {
  message:
    'must be a five-field cron expression: minute hour day-of-month month day-of-week, for example "*/15 * * * *"',
})

/**
 * The jobs the scheduler runs, and the names their schedules and their history are keyed by.
 * `plan` is deliberately absent until the planner exists (M6): a schedule for a job nothing
 * can run is a setting that does nothing, which is worse than one that is not there yet.
 */
export const scheduledJobs = ['sync', 'classify', 'purge'] as const
export type ScheduledJobName = (typeof scheduledJobs)[number]

/**
 * The defaults from spec 06, with one addition it does not name: `classify` runs at five past
 * rather than on the hour. The two schedules would otherwise coincide every hour, and the
 * chain's own sync step would be skipped as already running for no reason but arithmetic.
 * Purge is nightly and early, because it deletes and nothing waits on it.
 */
const defaultSchedules: Record<ScheduledJobName, string> = {
  sync: '*/15 * * * *',
  classify: '5 * * * *',
  purge: '20 3 * * *',
}

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
    jobs: z
      .object({
        /**
         * The zone every schedule is read in, so a daily 07:30 stays at 07:30 across a DST
         * change (spec 06, criterion 4). Defaults to whatever this machine thinks it is in,
         * which for a single-user local tool is the answer the user meant.
         */
        timezone: z
          .string()
          .min(1)
          .refine(isValidTimeZone, {
            message: 'must be an IANA timezone name, such as Europe/London',
          })
          .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
        schedules: z
          .object({
            sync: cronExpression.default(defaultSchedules.sync),
            classify: cronExpression.default(defaultSchedules.classify),
            purge: cronExpression.default(defaultSchedules.purge),
          })
          .strict()
          .default({}),
        /** The ceiling on the backoff after consecutive failures. Spec 06 says one hour. */
        backoffCeilingMinutes: z.number().int().min(1).max(1440).default(60),
        /** The first step of the backoff. Doubles per consecutive failure up to the ceiling. */
        backoffBaseMinutes: z.number().int().min(1).max(1440).default(1),
        /** How long `job_runs` rows are kept. Spec 06 says thirty days. */
        retainRunDays: z.number().int().min(1).max(3650).default(30),
        /** The gap between catch-up runs on a cold start, so they do not all fire at once. */
        startupStaggerSeconds: z.number().int().min(0).max(600).default(5),
      })
      .strict()
      .default({}),
    classification: z
      .object({
        /** How many inbox tasks one run will sort. Spec 04 says fifty. */
        batchSize: z.number().int().min(1).max(500).default(50),
        /**
         * At or above this, the classifier applies its answer; below it, the answer is a
         * proposal for the user to accept. Spec 04 says 0.75.
         */
        confidenceThreshold: z.number().min(0).max(1).default(0.75),
        /** How many classification calls are in flight at once. Spec 04: bounded. */
        concurrency: z.number().int().min(1).max(20).default(3),
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
        provider: llmField.provider().default('none'),
        model: llmField.model().default(null),
        baseUrl: llmField.baseUrl().default(null),
        maxTokens: llmField.maxTokens().default(4096),
        timeoutMs: llmField.timeoutMs().default(60_000),
        /**
         * Per-job partial configs. Spec 03 names classification and chat; the planner runs
         * on the base settings, because a plan is drawn once a day and is the one place
         * where paying for the better model is obviously worth it.
         */
        overrides: z
          .object({
            classification: llmOverrideSchema.optional(),
            chat: llmOverrideSchema.optional(),
          })
          .strict()
          .default({}),
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
            /**
             * The Gmail search that decides what is in scope. Spec 02's default leaves out the
             * two categories that are never anybody's next action. A thread leaving this result
             * set is what "handled in Gmail" means, so narrowing it retires tasks.
             */
            gmailQuery: z
              .string()
              .min(1)
              .max(500)
              .default('in:inbox -category:promotions -category:social'),
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
 * Everything needed to talk to one model. The base settings and each override resolve to
 * one of these at load time, so `src/llm` is handed a complete answer rather than a partial
 * one it would have to merge itself, and so the key each provider needs is looked up in the
 * environment exactly once, where the environment is still in scope.
 */
export interface LlmSettings {
  readonly provider: LlmProviderName
  readonly model: string | null
  readonly baseUrl: string | null
  readonly apiKey: string | null
  readonly maxTokens: number
  readonly timeoutMs: number
  /** True only for ollama, which is the whole of the "does content leave the machine" test. */
  readonly isLocal: boolean
  readonly configured: boolean
}

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
  readonly jobs: {
    readonly timezone: string
    readonly schedules: Readonly<Record<ScheduledJobName, string>>
    readonly backoffCeilingMinutes: number
    readonly backoffBaseMinutes: number
    readonly retainRunDays: number
    readonly startupStaggerSeconds: number
  }
  readonly classification: {
    readonly batchSize: number
    readonly confidenceThreshold: number
    readonly concurrency: number
  }
  readonly privacy: {
    readonly llmContent: ContentLevel
    readonly storeContent: ContentLevel
    readonly snippetChars: number
    readonly retainContentDays: number
    readonly allowFullContentToRemoteProvider: boolean
  }
  readonly llm: LlmSettings & {
    /** Null where no override is configured, which is the normal case for both. */
    readonly overrides: {
      readonly classification: LlmSettings | null
      readonly chat: LlmSettings | null
    }
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
      readonly gmailQuery: string
      /**
       * Where the OAuth tokens live: beside the database, mode 0600, never in config and never
       * in git (spec 09). Derived from the database path rather than configured, so that the
       * deletion command in spec 09 has one directory to remove.
       */
      readonly tokenPath: string
      /** A client id and secret are present. Whether anyone has consented is a separate fact. */
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
  // An override may name a different provider, and so may resolve a different key. Both are
  // listed, so an override pointing at a hosted provider cannot leak a key the base config
  // never held.
  ['llm', 'overrides', 'classification', 'apiKey'],
  ['llm', 'overrides', 'chat', 'apiKey'],
  ['integrations', 'github', 'token'],
  ['integrations', 'google', 'clientSecret'],
] as const satisfies readonly (readonly string[])[]
