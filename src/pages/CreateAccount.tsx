import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { AuthLayout } from '../layouts/AuthLayout'
import { Card, CardHeader, PrimaryButton, TextField } from '../components/ui'
import { useAuth } from '../lib/authContext'
import { AuthApiError } from '../lib/authApi'

export default function CreateAccount() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const passwordsMatch = password === confirmPassword
  const confirmError = confirmPassword && !passwordsMatch ? 'Passwords do not match.' : undefined

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!passwordsMatch) {
      setError('Passwords do not match.')
      return
    }
    setIsSubmitting(true)
    try {
      await register(username, password)
      navigate('/repair-orders', { replace: true })
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : 'Something went wrong creating the account.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader
          title="Create account"
          description="Use your real MXI username and password — this is what gets typed into MXI on your behalf."
        />
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <TextField label="Username" value={username} onChange={setUsername} autoComplete="username" autoFocus disabled={isSubmitting} />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            disabled={isSubmitting}
          />
          <TextField
            label="Confirm password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            disabled={isSubmitting}
            error={confirmError}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton type="submit" disabled={isSubmitting || !username || !password || !passwordsMatch}>
            <UserPlus size={16} />
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </PrimaryButton>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  )
}
