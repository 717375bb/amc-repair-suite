import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { AuthLayout } from '../layouts/AuthLayout'
import { Card, CardHeader, PrimaryButton, TextField } from '../components/ui'
import { useAuth } from '../lib/authContext'
import { AuthApiError } from '../lib/authApi'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      await login(username, password)
      navigate('/repair-orders', { replace: true })
    } catch (err) {
      setError(err instanceof AuthApiError ? err.message : 'Something went wrong logging in.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <Card>
        <CardHeader title="Log in" description="Username and password are the same as your MXI credentials." />
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <TextField label="Username" value={username} onChange={setUsername} autoComplete="username" autoFocus disabled={isSubmitting} />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            disabled={isSubmitting}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton type="submit" disabled={isSubmitting || !username || !password}>
            <LogIn size={16} />
            {isSubmitting ? 'Logging in...' : 'Log in'}
          </PrimaryButton>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm text-muted">
        No account yet?{' '}
        <Link to="/create-account" className="font-medium text-accent hover:underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  )
}
