import { Plus } from 'lucide-react'
import { Badge, Card, PrimaryButton } from '../components/ui'
import { discrepancies } from '../data/mockData'
import { statusTone } from '../lib/status'

export default function Discrepancies() {
  return (
    <div className="space-y-5" data-workflow="discrepancies">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Receiving discrepancies and paperwork issues tied to repair orders
        </p>
        <PrimaryButton>
          <Plus size={16} />
          Log Discrepancy
        </PrimaryButton>
      </div>

      <div className="space-y-3">
        {discrepancies.map((item) => (
          <Card key={item.id} className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-text">
                    {item.id}
                  </p>
                  <Badge tone="neutral">{item.type}</Badge>
                  <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                </div>
                <p className="mt-1.5 text-sm text-text">
                  {item.description}
                </p>
                <p className="mt-2 text-xs text-muted">
                  Linked to {item.relatedOrder} &middot; {item.vendor} &middot;
                  Opened {item.dateOpened}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
