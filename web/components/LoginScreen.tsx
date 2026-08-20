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
import { failureClassName } from './primitives.js'
import { Button } from './ui/button.js'

export interface LoginScreenProps {
  readonly providerLabel: string
  readonly failure: string | null
  readonly onLogin: () => void
}

export function LoginScreen({ providerLabel, failure, onLogin }: LoginScreenProps) {
  return (
    <div className="mx-auto my-12 flex max-w-[76ch] flex-col items-center gap-3 text-center">
      <p className="m-0 text-lg font-medium tracking-tight">Caroline</p>
      <p>Sign in to continue.</p>
      {failure !== null && (
        <p role="alert" className={failureClassName}>
          {failure}
        </p>
      )}
      <Button type="button" variant="default" onClick={onLogin}>
        Sign in with {providerLabel}
      </Button>
    </div>
  )
}
