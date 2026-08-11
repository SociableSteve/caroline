/**
 * Settings. Two things are answered here, and spec 09 asks that both be answered in plain language
 * rather than by naming a setting: what leaves this machine, and what stays on it.
 *
 * The payload preview is the point of the screen. A policy nobody can see the effect of is a policy
 * nobody can check, so the exact payload a classification call would carry, for a real item, is on
 * the page. Spec 09, criterion 9.
 */
import type { GoogleStatus, PrivacyPreview } from '../api.js'
import { formatDate } from '../format.js'
import { Fact, Facts, Panel } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

export interface SettingsProps {
  readonly google: GoogleStatus | null
  readonly preview: PrivacyPreview | null
  /** What the callback put in the URL, so the screen can say how connecting went. */
  readonly googleOutcome: string | null
  readonly onConnectGoogle: () => void
  readonly onDisconnectGoogle: () => void
  readonly onRefreshPreview: () => void
}

const outcomes: Record<string, string> = {
  connected: 'Google is connected.',
  refused: 'Google declined the request. Nothing was connected.',
  failed: 'Caroline could not finish connecting to Google. Try again.',
  incomplete: 'That callback was missing its code, so nothing was connected.',
}

export function Settings({
  google,
  preview,
  googleOutcome,
  onConnectGoogle,
  onDisconnectGoogle,
  onRefreshPreview,
}: SettingsProps) {
  useSurfaceTitle('Settings')

  return (
    <div className="settings-surface">
      <h1>Settings</h1>

      <Panel headingLevel={2} heading="Google account">
        {googleOutcome !== null && (
          <p role="status" className="settings-outcome">
            {outcomes[googleOutcome] ?? 'Something happened while connecting to Google.'}
          </p>
        )}

        {google === null ? (
          <p className="empty">Waiting for the server.</p>
        ) : !google.configured ? (
          <div>
            <p className="empty">
              No Google client is configured, so there is nothing to connect yet. Create a Google
              Cloud OAuth client, put its id in <code>integrations.google.clientId</code> and its
              secret in the <code>GOOGLE_CLIENT_SECRET</code> environment variable, then restart.
            </p>
            <p>
              The client will need this redirect URI: <code>{google.redirectUri}</code>
            </p>
          </div>
        ) : google.connected ? (
          <div>
            <p>
              Connected{google.connectedAt === null ? '' : ` on ${formatDate(google.connectedAt)}`}.
              Read-only, and only these scopes:
            </p>
            <ul className="scope-list">
              {google.scopes.map((scope) => (
                <li key={scope}>
                  <code>{scope}</code>
                </li>
              ))}
            </ul>
            <button type="button" onClick={onDisconnectGoogle}>
              Disconnect
            </button>
          </div>
        ) : (
          <div>
            <p>
              Not connected. Connecting opens Google in this browser and asks for read-only access
              to Gmail and Calendar. Caroline never writes to either.
            </p>
            <button type="button" className="primary" onClick={onConnectGoogle}>
              Connect Google
            </button>
          </div>
        )}
      </Panel>

      <Panel headingLevel={2} heading="What leaves this machine">
        {preview === null ? (
          <p className="empty">Waiting for the server.</p>
        ) : (
          <>
            <Facts>
              <Fact label="Sent to the model">
                <strong>{preview.policy.llmContent}</strong>
                {preview.policy.llmConsequence !== undefined && (
                  <span className="policy-consequence"> {preview.policy.llmConsequence}</span>
                )}
              </Fact>

              <Fact label="Stored on disk">
                <strong>{preview.policy.storeContent}</strong>
                {preview.policy.storeConsequence !== undefined && (
                  <span className="policy-consequence"> {preview.policy.storeConsequence}</span>
                )}
              </Fact>

              <Fact label="Snippet length">{preview.policy.snippetChars} characters</Fact>
            </Facts>

            {/* Editing these is a restart away: they live in the config file, and the two questions
                they answer are the sort a person should decide deliberately rather than by dragging
                a slider. Spec 09 keeps them in `privacy`. */}
            <p className="policy-note">
              Change these in <code>caroline.config.json</code> under <code>privacy</code>, then
              restart Caroline.
            </p>
          </>
        )}
      </Panel>

      <Panel headingLevel={2} heading="What a classification call would send">
        {preview === null ? (
          <p className="empty">Waiting for the server.</p>
        ) : preview.item === null ? (
          <p className="empty">
            Nothing is in the inbox, so there is no real item to preview. Once something arrives,
            exactly what would be sent about it appears here.
          </p>
        ) : (
          <>
            <p>
              For <strong>{preview.item.title}</strong>
              {preview.item.provider === null ? '' : ` (${preview.item.provider})`}, under the
              policy above, this is the whole payload:
            </p>
            <pre className="payload-preview">{JSON.stringify(preview.payload, null, 2)}</pre>
            {preview.promptVersion !== undefined && (
              <p className="policy-note">Prompt version {preview.promptVersion}.</p>
            )}
            <button type="button" onClick={onRefreshPreview}>
              Refresh
            </button>
          </>
        )}
      </Panel>
    </div>
  )
}
