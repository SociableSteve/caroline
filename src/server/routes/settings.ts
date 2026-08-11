import type { FastifyInstance } from 'fastify'
import type { Database } from '../../db/index.js'
import { getUserName, setUserName } from '../../db/repositories/settings.js'
import { validateUserName } from '../../domain/settings.js'
import { apiError } from '../errors.js'
import { settingsResponseSchema, settingsUpdateSchema } from '../schemas.js'

export interface SettingsRouteContext {
  readonly database: Database
  readonly now: () => number
}

/**
 * The Settings surface's first write path. Spec 09: the person's name is data about a person rather
 * than deployment configuration, so it lives in the database and not in `caroline.config.json`,
 * which nothing writes to and which a restart would have to be reasoned about.
 *
 * What the name does to a prompt is not answered here. `GET /api/privacy/preview` renders the
 * preamble the providers are handed, so there is one preview of what leaves the machine rather than
 * two that could disagree.
 */
export function registerSettingsRoutes(
  app: FastifyInstance,
  { database, now }: SettingsRouteContext,
): void {
  const answer = () => ({ userName: getUserName(database) })

  app.get(
    '/api/settings',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: settingsResponseSchema },
      },
    },
    async () => answer(),
  )

  app.patch<{ Body: { userName?: string } }>(
    '/api/settings',
    { schema: { body: settingsUpdateSchema, response: { 200: settingsResponseSchema } } },
    async (request, reply) => {
      const { userName } = request.body

      if (userName !== undefined) {
        // Checked here rather than left to the schema alone. The schema bounds the length; this is
        // the rule about what the text may contain, and it answers with the sentence a person can
        // act on rather than with a validator's path.
        const checked = validateUserName(userName)
        if (!checked.ok) {
          return reply.status(400).send(apiError('bad_request', checked.message))
        }

        setUserName(database, checked.value, now())
      }

      return answer()
    },
  )
}
