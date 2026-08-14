import { AlertTriangle } from 'lucide-react'
import { Card, PrimaryButton, SecondaryButton } from './ui'

/**
 * Generic confirm/warning modal — same visual pattern already proven in
 * EnvironmentBar's inline "Switch to Production?" dialog, pulled out here
 * so other consequential actions (starting with the cancel-run button) can
 * reuse it instead of growing a second, potentially-drifting copy.
 * EnvironmentBar keeps its own original inline version untouched, per the
 * same "don't risk regressing an already-working confirm" reasoning that
 * motivated pulling EnvironmentBar itself out earlier.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Never mind',
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'danger' | 'accent'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-md p-6">
        <div className={`flex items-center gap-2 ${tone === 'danger' ? 'text-danger' : 'text-accent'}`}>
          <AlertTriangle size={20} />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <p className="mt-3 text-sm text-text">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <SecondaryButton onClick={onCancel}>{cancelLabel}</SecondaryButton>
          {tone === 'danger' ? (
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex items-center gap-2 rounded-md bg-danger px-3.5 py-2 text-sm font-medium text-white transition-colors hover:opacity-90"
            >
              {confirmLabel}
            </button>
          ) : (
            <PrimaryButton onClick={onConfirm}>{confirmLabel}</PrimaryButton>
          )}
        </div>
      </Card>
    </div>
  )
}
