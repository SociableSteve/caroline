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
  /**
   * Whether the model can be given tools, which is what decides whether chat can make changes
   * at all (spec 07, criterion 7). Absent means "decide from the provider": the hosted two
   * can, and Ollama's answer depends on the model, so it is asked for rather than assumed.
   * Declaring it wrongly optimistically would have chat offer changes the model cannot make.
   */
  supportsTools: () => z.boolean(),
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
    supportsTools: llmField.supportsTools().optional(),
  })
  .strict()

const cronExpression = z.string().refine(isValidCron, {
  message:
    'must be a five-field cron expression: minute hour day-of-month month day-of-week, for example "*/15 * * * *"',
})

/**
 * The jobs the scheduler runs, and the names their schedules and their history are keyed by.
 */
export const scheduledJobs = ['sync', 'classify', 'plan', 'purge'] as const
export type ScheduledJobName = (typeof scheduledJobs)[number]

/**
 * The defaults from spec 06, with one addition it does not name: `classify` runs at five past
 * rather than on the hour. The two schedules would otherwise coincide every hour, and the
 * chain's own sync step would be skipped as already running for no reason but arithmetic.
 * The plan is drawn at 07:30, before the working day. Purge is nightly and early, because it
 * deletes and nothing waits on it.
 */
const defaultSchedules: Record<ScheduledJobName, string> = {
  sync: '*/15 * * * *',
  classify: '5 * * * *',
  plan: '30 7 * * *',
  purge: '20 3 * * *',
}

/** A local clock time, `HH:MM` on a 24-hour clock. What the working window is written in. */
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour local time such as 09:00')

/**
 * A set of weekdays, Sunday as zero, as cron and `Date` both number them. Sorted on the way in
 * so that a configuration listing Friday before Monday still reads in order everywhere it is
 * shown, and repeats are refused rather than deduplicated: a day named twice is a mistake in
 * the file, and quietly accepting it would hide the typo next to it.
 */
const weekdays = z
  .array(z.number().int().min(0).max(6))
  .min(1, 'must name at least one working day')
  .refine((days) => new Set(days).size === days.length, 'must not name the same day twice')
  .transform((days) => days.toSorted((first, second) => first - second))

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
        /**
         * The URL the browser reaches Caroline at. Setting it makes authentication required
         * (spec 13), and it is where the redirect URI is derived from where it is set. Nullable
         * with a null default, the shape `integrations.google.clientId` already uses.
         */
        publicUrl: z.string().url().nullable().default(null),
      })
      .strict()
      .default({}),
    /**
     * Spec 13. Every key here has a default, so a file with no `auth` block at all, which is
     * every configuration file in existence today, loads exactly as it did before this spec.
     */
    auth: z
      .object({
        mode: z.enum(['auto', 'required']).default('auto'),
        /**
         * Allowed identities: an email address, or `sub:<value>`. The same bounds
         * `integrations.google.calendarIds` carries.
         */
        allow: z.array(z.string().min(1).max(320)).max(20).default([]),
        sessionIdleDays: z.number().int().min(1).max(30).default(7),
        sessionMaxDays: z.number().int().min(1).max(30).default(30),
        provider: z
          .object({
            label: z.string().min(1).default('Google'),
            issuer: z.string().url().default('https://accounts.google.com'),
            /** Nullable with a null default: the one key whose absence means "no provider configured". */
            clientId: z.string().min(1).nullable().default(null),
            scopes: z.array(z.string().min(1)).default(['openid', 'email']),
          })
          .strict()
          .default({}),
      })
      .strict()
      .refine((auth) => auth.sessionMaxDays >= auth.sessionIdleDays, {
        message: 'auth.sessionMaxDays must be at least auth.sessionIdleDays',
        path: ['sessionMaxDays'],
      })
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
            plan: cronExpression.default(defaultSchedules.plan),
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
    chat: z
      .object({
        /**
         * How many tool calls one turn may make. Spec 07 says twenty-five: enough to triage a
         * pile of inbox items, few enough that a model in a loop stops costing money.
         */
        maxToolCalls: z.number().int().min(1).max(500).default(25),
        /**
         * How many tasks a turn may change before the rest of it needs confirming. Spec 07's
         * bulk threshold, default ten. With one task per write tool, a bulk operation is a turn
         * that keeps going, so the count is the turn's and not one call's.
         */
        bulkConfirmThreshold: z.number().int().min(1).max(500).default(10),
        /**
         * How many earlier messages of a conversation are sent with a turn. The transcript is
         * kept whole either way; this bounds what one turn costs on a conversation that has been
         * going for a week. Task detail is fetched through tools (spec 07), so an older message
         * carries the thread of the discussion rather than data the model still needs.
         */
        contextMessages: z.number().int().min(2).max(200).default(40),
      })
      .strict()
      .default({}),
    planning: z
      .object({
        /**
         * The working day, in local clock time. Spec 05's default is 09:00 to 17:30, which
         * with the default reserve leaves a little under seven hours to plan into.
         */
        workingWindow: z
          .object({
            start: timeOfDay.default('09:00'),
            end: timeOfDay.default('17:30'),
          })
          .strict()
          .refine(
            (window) => window.end > window.start,
            // Lexicographic comparison is correct for zero-padded 24-hour times, and saying it
            // in minutes here would only put a second parser next to the one in the domain.
            'the working day must end after it starts',
          )
          .default({}),
        /** Sunday is 0. Spec 05 defaults to Monday to Friday. */
        workingDays: weekdays.default([1, 2, 3, 4, 5]),
        /**
         * Held back for interruptions, as a percentage of the window. Spec 05: nobody gets to
         * spend every free minute on planned work. A hundred is a day with nothing in it,
         * which is a strange choice but a coherent one; above it is not.
         */
        reservePercent: z.number().int().min(0).max(100).default(20),
        /** What a task with no estimate is fitted at, so it can still be fitted. Spec 05. */
        defaultEstimateMinutes: z.number().int().min(1).max(480).default(30),
        /**
         * Whether an all-day event takes the day. Spec 02 defaults it off: a public holiday
         * and a week-long conference are both all-day events, and only one means you are busy.
         */
        countAllDayEvents: z.boolean().default(false),
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
        supportsTools: llmField.supportsTools().optional(),
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
            /**
             * Calendars to read besides the primary one. Spec 02: the primary calendar plus
             * any additional ids configured. Empty is the normal case for one person.
             */
            calendarIds: z.array(z.string().min(1).max(320)).max(20).default([]),
            /**
             * The rolling window the calendar is read over. Spec 02's default is a day back
             * and a fortnight forward: yesterday because a plan drawn this morning is still
             * being looked at, and a fortnight because nothing further out changes capacity
             * today.
             */
            calendarLookbackDays: z.number().int().min(0).max(30).default(1),
            calendarLookaheadDays: z.number().int().min(1).max(365).default(14),
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
  /** Whether tools may be offered to this model. False makes chat read-only. Spec 07. */
  readonly supportsTools: boolean
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
    readonly publicUrl: string | null
  }
  /**
   * Whether a request needs a session. Computed once at startup from `server.host`,
   * `server.publicUrl` and `auth.mode` (`src/auth/boundary.ts`). Spec 13: the one derived fact
   * every check reads, so the rule is decided in one place rather than inferred in several.
   */
  readonly authRequired: boolean
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
  readonly chat: {
    readonly maxToolCalls: number
    readonly bulkConfirmThreshold: number
    readonly contextMessages: number
  }
  readonly planning: {
    /** Local clock times, `HH:MM`. `src/domain/time.ts` turns them into instants for a date. */
    readonly workingWindow: { readonly start: string; readonly end: string }
    /** Sunday is 0, ascending. */
    readonly workingDays: readonly number[]
    readonly reservePercent: number
    readonly defaultEstimateMinutes: number
    readonly countAllDayEvents: boolean
  }
  readonly privacy: {
    readonly llmContent: ContentLevel
    readonly storeContent: ContentLevel
    readonly snippetChars: number
    readonly retainContentDays: number
    readonly allowFullContentToRemoteProvider: boolean
  }
  readonly auth: {
    readonly mode: 'auto' | 'required'
    readonly allow: readonly string[]
    readonly sessionIdleDays: number
    readonly sessionMaxDays: number
    readonly provider: {
      readonly label: string
      readonly issuer: string
      readonly clientId: string | null
      /** From `CAROLINE_AUTH_CLIENT_SECRET` only. Null is a supported state (spec 13). */
      readonly clientSecret: string | null
      readonly scopes: readonly string[]
    }
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
      /** Calendars besides the primary one. Spec 02. */
      readonly calendarIds: readonly string[]
      readonly calendarLookbackDays: number
      readonly calendarLookaheadDays: number
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
  ['llm', 'apiKey'],
  // An override may name a different provider, and so may resolve a different key. Both are
  // listed, so an override pointing at a hosted provider cannot leak a key the base config
  // never held.
  ['llm', 'overrides', 'classification', 'apiKey'],
  ['llm', 'overrides', 'chat', 'apiKey'],
  ['integrations', 'github', 'token'],
  ['integrations', 'google', 'clientSecret'],
  ['auth', 'provider', 'clientSecret'],
] as const satisfies readonly (readonly string[])[]
