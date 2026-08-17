/**
 * Settings. Two things are answered here, and spec 09 asks that both be answered in plain language
 * rather than by naming a setting: what leaves this machine, and what stays on it.
 *
 * The payload preview is the point of the screen. A policy nobody can see the effect of is a policy
 * nobody can check, so the exact payload a classification call would carry, for a real item, is on
 * the page. Spec 09, criterion 9.
 */
import { useEffect, useState } from 'react'
import type { GoogleStatus, McpClientView, McpConsentView, PrivacyPreview } from '../api.js'
import { formatDate } from '../format.js'
import { ActionRow, Fact, Facts, Field, Panel } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

export interface SettingsProps {
  readonly google: GoogleStatus | null
  readonly preview: PrivacyPreview | null
  /** What Caroline calls the person using it. Empty is a supported answer. Spec 09. */
  readonly userName: string
  /** What the callback put in the URL, so the screen can say how connecting went. */
  readonly googleOutcome: string | null
  readonly onConnectGoogle: () => void
  readonly onDisconnectGoogle: () => void
  readonly onRefreshPreview: () => void
  /** Answers whether it saved, so a refused name is not reported as having been accepted. */
  readonly onSaveUserName: (name: string) => Promise<boolean>
  /**
   * Every MCP client already approved once, and a way to revoke one. Spec 08. Null while it has
   * not been read yet, which is also what a loopback install with `mcp.enabled` false answers
   * with, so the panel says nothing rather than showing an empty list that never fills.
   */
  readonly mcpClients: readonly McpClientView[] | null
  readonly onRevokeMcpClient: (clientId: string) => void
  /**
   * The pending authorisation request `GET /api/mcp/authorize` redirected here for, read from
   * the hash. `undefined` means none is named in the URL; `null` means one was named but has
   * since expired, was already decided, or never existed. Spec 12, criterion 31.
   */
  readonly mcpConsent: McpConsentView | null | undefined
  readonly onDecideMcpConsent: (approve: boolean) => void
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
  userName,
  googleOutcome,
  onConnectGoogle,
  onDisconnectGoogle,
  onRefreshPreview,
  onSaveUserName,
  mcpClients,
  onRevokeMcpClient,
  mcpConsent,
  onDecideMcpConsent,
}: SettingsProps) {
  useSurfaceTitle('Settings')
  const [typed, setTyped] = useState(userName)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // The server's answer wins whenever it changes: what is in the box otherwise survives a reload of
  // the screen and could be a name that was refused.
  useEffect(() => {
    setTyped(userName)
  }, [userName])

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

      {/*
        The consent screen the authorisation flow lands on (spec 12, criterion 31). Shown only
        while the URL names a pending request: it is not a state of the panel below it, because
        approving or denying it sends the browser away to the client's own redirect URI, and
        there is nothing to show here once that has happened.
      */}
      {mcpConsent !== undefined && (
        <Panel headingLevel={2} heading="An assistant is asking to connect">
          {mcpConsent === null ? (
            <p className="empty">
              That request has expired, was already decided, or does not exist. Ask the assistant to
              try connecting again.
            </p>
          ) : (
            <div>
              <p>
                <strong>{mcpConsent.clientName ?? mcpConsent.clientId}</strong> is asking to connect
                to Caroline over MCP. Once approved, it can read and change your board exactly as
                chat can, through the same content policy, the same confirmation for a delete or a
                bulk change, and the same undo.
              </p>
              <Facts>
                <Fact label="Client">{mcpConsent.clientUri ?? mcpConsent.clientId}</Fact>
                <Fact label="Redirects to">{mcpConsent.redirectUri}</Fact>
              </Facts>
              <ActionRow>
                <button type="button" className="primary" onClick={() => onDecideMcpConsent(true)}>
                  Approve
                </button>
                <button type="button" onClick={() => onDecideMcpConsent(false)}>
                  Deny
                </button>
              </ActionRow>
            </div>
          )}
        </Panel>
      )}

      {/* Spec 08: "a list of the clients already approved with a way to revoke one." Null
          (mcp.enabled false, or not read yet) is nothing shown at all, rather than an empty
          list that looks like a promise nothing is connected. */}
      {mcpClients !== null && (
        <Panel headingLevel={2} heading="Assistants connected over MCP">
          {mcpClients.length === 0 ? (
            <p className="empty">No assistant has been approved yet.</p>
          ) : (
            <ul className="mcp-client-list">
              {mcpClients.map((client) => (
                <li key={client.clientId}>
                  <span>{client.clientName ?? client.clientId}</span>
                  {client.approvedAt !== null && (
                    <span className="policy-note"> Approved {formatDate(client.approvedAt)}.</span>
                  )}
                  <button type="button" onClick={() => onRevokeMcpClient(client.clientId)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {/* Spec 09: a name is data about a person rather than deployment configuration, so it is
          written here rather than hand-edited into `caroline.config.json`. */}
      <Panel headingLevel={2} heading="Who Caroline is talking to">
        <p>
          Caroline tells the model your name so that it writes to you rather than about you. It is
          sent on every chat and planning call, including to a remote provider.
        </p>

        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            setSaving(true)
            setSaved(false)
            void onSaveUserName(typed.trim())
              .then((ok) => setSaved(ok))
              // The shell reports its own write failures and answers false rather than rejecting,
              // but a component that assumes that is a component that breaks when it stops being
              // true. A rejection is a save that did not happen, which is what false already means.
              .catch(() => setSaved(false))
              .finally(() => setSaving(false))
          }}
        >
          <Field label="Your name">
            <input
              name="userName"
              value={typed}
              autoComplete="off"
              onChange={(event) => {
                setTyped(event.target.value)
                setSaved(false)
              }}
            />
          </Field>
          <ActionRow>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving' : 'Save'}
            </button>
          </ActionRow>
        </form>

        <p className="policy-note">
          Leave it empty and Caroline will not address you by name, and will not send one.
        </p>

        {saved && (
          <p role="status" className="settings-outcome">
            Saved. The next turn and the next plan will use it.
          </p>
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

      {/* The preamble is the one thing every call carries, so it is previewed on its own rather
          than inside the classification payload, which does not carry it. Spec 09. */}
      <Panel headingLevel={2} heading="What every chat and planning call says about you">
        {preview?.preamble === undefined ? (
          <p className="empty">Waiting for the server.</p>
        ) : (
          <>
            <p>
              This is the preamble, word for word, as it will be sent. It is built from the same
              function the model is handed, so it cannot drift from what leaves the machine.
            </p>
            <pre className="payload-preview">{preview.preamble}</pre>
          </>
        )}
      </Panel>

      {/* The item context is the newest thing leaving the machine, so a preview without it is no
          longer a preview of the policy. Built by the function a turn builds it with. Spec 09. */}
      <Panel headingLevel={2} heading="What a message about an open item would send">
        {preview === null ? (
          // A preview that has not arrived is not a preview saying nothing is captured, which is the
          // distinction every other panel here draws.
          <p className="empty">Waiting for the server.</p>
        ) : preview.itemContext == null ? (
          <p className="empty">
            Nothing is captured yet, so there is no real item to show. Open one in the rail and this
            is what a message about it would carry.
          </p>
        ) : (
          <>
            <p>
              With an item open in the chat rail, this is what your next message sends about it,
              under the policy above. Fields sent: {preview.itemContext.fields.join(', ')}, at
              content level {preview.itemContext.contentLevel}.
            </p>
            <pre className="payload-preview">{preview.itemContext.rendered}</pre>
            <p className="policy-note">
              Content policy version {preview.itemContext.policyVersion}.
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
