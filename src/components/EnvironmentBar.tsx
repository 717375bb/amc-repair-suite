import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Card, PrimaryButton, SecondaryButton } from './ui'

export type MxiEnv = 'stage' | 'production'

/**
 * Shared environment selector — stage is always the default; production
 * requires a separate, explicit confirmation before it can be used to
 * write anything real. Lifted out as its own component so new tabs (like
 * Open Order ESD Finder) can reuse the exact same proven design instead of
 * a second, potentially-drifting copy — pages/OrderWriteUps.tsx keeps its
 * own original inline version untouched, so this carries zero risk of
 * regressing that already-working tab.
 */
export function EnvironmentBar({
  env,
  onChange,
  disabled,
}: {
  env: MxiEnv
  onChange: (env: MxiEnv) => void
  disabled: boolean
}) {
  const [showProdConfirm, setShowProdConfirm] = useState(false)

  return (
    <div
      className={`flex items-center justify-between rounded-md border px-4 py-2.5 ${
        env === 'production' ? 'border-danger bg-danger-soft' : 'border-border bg-surface'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Environment</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange('stage')}
            className={`px-3 py-1 text-sm font-medium ${env === 'stage' ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'}`}
          >
            Stage
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (env !== 'production') setShowProdConfirm(true)
            }}
            className={`px-3 py-1 text-sm font-medium ${env === 'production' ? 'bg-danger text-white' : 'bg-surface text-text hover:bg-bg'}`}
          >
            Production
          </button>
        </div>
      </div>
      {env === 'production' && (
        <span className="flex items-center gap-1.5 text-xs font-semibold text-danger">
          <AlertTriangle size={14} />
          Writes will hit REAL Maintenix data
        </span>
      )}

      {showProdConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <Card className="w-full max-w-md p-6">
            <div className="flex items-center gap-2 text-danger">
              <AlertTriangle size={20} />
              <h3 className="text-sm font-semibold">Switch to Production?</h3>
            </div>
            <p className="mt-3 text-sm text-text">
              Writes from this run will hit <strong>real Maintenix data</strong>. This is not the default — confirm
              this is intentional before proceeding.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <SecondaryButton onClick={() => setShowProdConfirm(false)}>Cancel</SecondaryButton>
              <PrimaryButton
                onClick={() => {
                  onChange('production')
                  setShowProdConfirm(false)
                }}
              >
                Yes, use Production
              </PrimaryButton>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
