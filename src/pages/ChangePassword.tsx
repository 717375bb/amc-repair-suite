import { useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { Card, CardHeader, PrimaryButton, TextField } from '../components/ui'
import { changePassword as changePasswordApi, AuthApiError } from '../lib/authApi'

/**
 * Reachable from within the logged-in app (TopBar) — per explicit user
 * direction: "we have to change MXI credentials sometimes." Requires the
 * CURRENT password rather than a token/email reset (no email infra exists,
 * and this project's own login password IS the real MXI password, so
 * proving you still know it is the right bar here).
 */
export default function ChangePassword() {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const passwordsMatch = newPassword === confirmPassword
  const confirmError = confirmPassword && !passwordsMatch ? 'Passwords do not match.' : undefined

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (!passwordsMatch) {
      setError('New password and confirmation do not match.')
      return
    }
    setIsSubmitting(true)
    try {
      await changePasswordApi(oldPassword, newPassword)
      setSuccess(true)
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : 'Something went wrong changing the password.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-sm">
      <Card>
        <CardHeader
          title="Change password"
          description="Updates both your login password and the credential used to write into MXI — use this whenever your real MXI password changes."
        />
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <TextField
            label="Current password"
            type="password"
            value={oldPassword}
            onChange={setOldPassword}
            autoComplete="current-password"
            autoFocus
            disabled={isSubmitting}
          />
          <TextField
            label="New password"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            disabled={isSubmitting}
          />
          <TextField
            label="Confirm new password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            disabled={isSubmitting}
            error={confirmError}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          {success && <p className="text-sm text-success">Password updated.</p>}
          <PrimaryButton type="submit" disabled={isSubmitting || !oldPassword || !newPassword || !passwordsMatch}>
            <KeyRound size={16} />
            {isSubmitting ? 'Updating...' : 'Update password'}
          </PrimaryButton>
        </form>
      </Card>
    </div>
  )
}
