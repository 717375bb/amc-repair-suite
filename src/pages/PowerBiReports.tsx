import { ExternalLink, LayoutGrid } from 'lucide-react'
import { Card, CardHeader } from '../components/ui'
import { POWERBI_REPORTS, POWERBI_WORKSPACE_URL } from '../lib/powerBiConfig'

/**
 * Link-out PowerBI Reports — per explicit user direction (2026-09-09), see
 * lib/powerBiConfig.ts's own docstring for why this isn't a real embed yet
 * and what upgrading to one would take.
 *
 * Every link opens in a new browser tab (rel="noopener noreferrer" — this
 * suite's window never loses its own place, and the new tab can't reach
 * back into it) using the analyst's own PowerBI/Microsoft 365 login, same
 * as opening PowerBI directly.
 *
 * Links are styled to match PrimaryButton/SecondaryButton (components/ui.tsx)
 * directly, as plain <a> tags rather than a <button> nested inside an <a> —
 * that nesting is invalid HTML and unreliable to click in some browsers.
 */
export default function PowerBiReports() {
  return (
    <div className="space-y-5" data-workflow="powerbi-reports">
      <Card className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <LayoutGrid size={22} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <p className="text-sm font-semibold text-text">Your PowerBI workspace</p>
            <p className="mt-0.5 text-sm text-muted">
              Opens in a new tab, using your own PowerBI login — everything you have access to today.
            </p>
          </div>
        </div>
        <a
          href={POWERBI_WORKSPACE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <ExternalLink size={16} />
          Open Workspace
        </a>
      </Card>

      <Card>
        <CardHeader
          title="Individual reports"
          description={
            POWERBI_REPORTS.length > 0
              ? 'One-click shortcuts to specific reports, maintained in src/lib/powerBiConfig.ts.'
              : 'No individual report shortcuts configured yet.'
          }
        />
        {POWERBI_REPORTS.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {POWERBI_REPORTS.map((report) => (
              <div key={report.url} className="flex flex-col justify-between gap-3 rounded-md border border-border bg-surface p-4">
                <div>
                  <p className="text-sm font-semibold text-text">{report.name}</p>
                  {report.description && <p className="mt-1 text-xs text-muted">{report.description}</p>}
                </div>
                <a
                  href={report.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
                >
                  <ExternalLink size={14} />
                  Open
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-muted">
            Add your reports to <code className="rounded bg-bg px-1.5 py-0.5 text-xs">src/lib/powerBiConfig.ts</code> —
            each one needs just a name and the report's PowerBI URL. Use the Workspace button above in the meantime.
          </div>
        )}
      </Card>
    </div>
  )
}
