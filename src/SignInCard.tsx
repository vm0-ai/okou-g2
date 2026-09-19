import { useState, type FormEvent } from 'react'
import { useSignIn } from '@clerk/clerk-react'

/** Pull the most useful message out of a Clerk error payload. */
function describeError(error: unknown): string {
  const clerkErrors = (error as { errors?: { longMessage?: string; message?: string }[] })?.errors
  const first = clerkErrors?.[0]
  if (first) return first.longMessage ?? first.message ?? 'Sign-in failed'
  if (error instanceof Error) return error.message
  return 'Sign-in failed'
}

/**
 * Custom Clerk email-code sign-in.
 *
 * The hosted Clerk UI is avoided on purpose: this screen is typed on a phone
 * inside the Even App WebView, where a redirect-based flow has no reliable way
 * back. Everything stays on one page.
 */
export default function SignInCard() {
  const { isLoaded, signIn, setActive } = useSignIn()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendCode(event: FormEvent) {
    event.preventDefault()
    if (!isLoaded || busy) return
    setBusy(true)
    setError(null)
    try {
      const attempt = await signIn.create({ identifier: email.trim() })
      const factor = attempt.supportedFirstFactors?.find(
        (candidate) => candidate.strategy === 'email_code',
      )
      if (!factor || !('emailAddressId' in factor)) {
        throw new Error('This account cannot sign in with an email code.')
      }
      await signIn.prepareFirstFactor({
        strategy: 'email_code',
        emailAddressId: factor.emailAddressId,
      })
      setStep('code')
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault()
    if (!isLoaded || busy) return
    setBusy(true)
    setError(null)
    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: 'email_code',
        code: code.trim(),
      })
      if (attempt.status !== 'complete') {
        throw new Error(`Additional verification required (${attempt.status}).`)
      }
      await setActive({ session: attempt.createdSessionId })
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }

  function restart() {
    setStep('email')
    setCode('')
    setError(null)
  }

  return (
    <section className="card">
      <h2>Sign in</h2>
      {step === 'email' ? (
        <form onSubmit={sendCode}>
          <p className="hint">Use the email address of your Okou account.</p>
          <input
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <button type="submit" disabled={!isLoaded || busy || !email.trim()}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode}>
          <p className="hint">
            Enter the 6-digit code sent to <strong>{email}</strong>.
          </p>
          <input
            type="text"
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            className="code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            required
          />
          <button type="submit" disabled={!isLoaded || busy || code.trim().length < 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" className="link" onClick={restart} disabled={busy}>
            Use a different email
          </button>
        </form>
      )}
      {error ? <p className="error">{error}</p> : null}
    </section>
  )
}
