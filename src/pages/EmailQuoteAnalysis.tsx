import { useState } from 'react'
import { Mail, Sparkles } from 'lucide-react'
import {
  Badge,
  Card,
  CardHeader,
  PrimaryButton,
  SecondaryButton,
} from '../components/ui'
import { emailQuotes } from '../data/mockData'
import { statusTone } from '../lib/status'

export default function EmailQuoteAnalysis() {
  const [selectedId, setSelectedId] = useState(emailQuotes[0].id)
  const selected =
    emailQuotes.find((email) => email.id === selectedId) ?? emailQuotes[0]

  return (
    <div
      className="grid grid-cols-1 gap-5 lg:grid-cols-[380px_1fr]"
      data-workflow="email-quotes"
    >
      <Card className="flex max-h-[calc(100vh-7.5rem)] flex-col">
        <CardHeader
          title="Inbox: Repair Quotes"
          description={`${emailQuotes.length} parsed emails`}
        />
        <ul className="flex-1 overflow-y-auto">
          {emailQuotes.map((email) => (
            <li key={email.id}>
              <button
                type="button"
                onClick={() => setSelectedId(email.id)}
                className={[
                  'flex w-full flex-col gap-1 border-b border-border px-5 py-3 text-left transition-colors',
                  email.id === selectedId ? 'bg-accent-soft' : 'hover:bg-bg',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-text">
                    {email.subject}
                  </span>
                </div>
                <span className="truncate text-xs text-muted">
                  {email.sender}
                </span>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted">{email.received}</span>
                  <Badge tone={statusTone(email.status)}>
                    {email.status}
                  </Badge>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title={selected.subject}
          description={`From ${selected.sender} · ${selected.received}`}
          action={
            <Badge tone={statusTone(selected.status)}>{selected.status}</Badge>
          }
        />

        <div className="space-y-5 p-5">
          <div className="flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
            <Sparkles size={16} />
            AI-extracted quote details &mdash; verify before approving
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Vendor" value={selected.vendor} />
            <Field label="Part Number" value={selected.partNumber} />
            <Field label="Quoted Price" value={selected.quotedPrice} />
            <Field
              label="Turnaround"
              value={`${selected.turnaroundDays} days`}
            />
            <Field label="Linked Order" value="RO-10482" />
            <Field label="Source" value="Email" />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              Original Message
            </p>
            <div className="flex items-start gap-3 rounded-md border border-border bg-bg p-4 text-sm text-muted">
              <Mail size={18} className="mt-0.5 shrink-0" />
              <p>
                Full email body preview will render here once email
                integration is connected. This panel will show the raw
                message alongside the structured fields the AI agent
                extracted, so quotes can be verified at a glance.
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <SecondaryButton>Flag for Review</SecondaryButton>
            <PrimaryButton>Approve Quote</PrimaryButton>
          </div>
        </div>
      </Card>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-sm font-medium text-text">{value}</p>
    </div>
  )
}
