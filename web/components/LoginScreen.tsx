/**
 * The screen the shell renders in place of a surface when the API says the request is
 * unauthenticated. Spec 13: "The login screen is not a surface." It has no route, no navigation
 * entry and no hash of its own, and it owns no `document.title`, because both of those belong to
 * a surface and this is deliberately not one (spec 08, criterion 33).
 *
 * One button naming the provider, and, where a login attempt itself failed, one sentence saying
 * so. There is nothing else to press: any 401 puts the client here rather than retrying, and this
 * is the whole of what it can do about it.
 */
export interface LoginScreenProps {
  readonly providerLabel: string
  readonly failure: string | null
  readonly onLogin: () => void
}

export function LoginScreen({ providerLabel, failure, onLogin }: LoginScreenProps) {
  return (
    <div className="login-screen">
      <p className="wordmark">Caroline</p>
      <p>Sign in to continue.</p>
      {failure !== null && (
        <p role="alert" className="failure">
          {failure}
        </p>
      )}
      <button type="button" className="primary" onClick={onLogin}>
        Sign in with {providerLabel}
      </button>
    </div>
  )
}
