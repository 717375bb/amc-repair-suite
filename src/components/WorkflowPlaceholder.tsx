import type { LucideIcon } from 'lucide-react'
import { Card } from './ui'

export function WorkflowPlaceholder({
  icon: Icon,
  title,
  description,
  scope,
}: {
  icon: LucideIcon
  title: string
  description: string
  scope: string[]
}) {
  return (
    <Card className="p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon size={24} />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text">{title}</h2>
      <p className="mt-1 max-w-xl text-sm text-muted">{description}</p>

      <div className="mt-6 max-w-xl rounded-md border border-border bg-bg p-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Planned for this workflow
        </p>
        <ul className="space-y-1.5 text-sm text-text">
          {scope.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-accent">&bull;</span>
              {line}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}
