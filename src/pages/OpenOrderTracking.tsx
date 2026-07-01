import { Download } from 'lucide-react'
import { Badge, Card, CardHeader, SecondaryButton } from '../components/ui'
import { openOrders } from '../data/mockData'
import { statusTone } from '../lib/status'

const stats = [
  { label: 'Open Orders', value: openOrders.length.toString() },
  {
    label: 'Avg. Days Open',
    value: Math.round(
      openOrders.reduce((sum, o) => sum + o.daysOpen, 0) / openOrders.length,
    ).toString(),
  },
  {
    label: 'Past 14 Days',
    value: openOrders.filter((o) => o.daysOpen > 14).length.toString(),
  },
  { label: 'Vendors Involved', value: '5' },
]

export default function OpenOrderTracking() {
  return (
    <div className="space-y-5" data-workflow="open-orders">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} className="px-4 py-3">
            <p className="text-xs text-muted">{stat.label}</p>
            <p className="mt-1 text-2xl font-semibold text-text">
              {stat.value}
            </p>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Open Order Tracker"
          description="Synced view of in-progress repair orders"
          action={
            <SecondaryButton>
              <Download size={16} />
              Export
            </SecondaryButton>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-medium">RO #</th>
                <th className="px-5 py-3 font-medium">Part Number</th>
                <th className="px-5 py-3 font-medium">Aircraft</th>
                <th className="px-5 py-3 font-medium">Vendor</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Days Open</th>
                <th className="px-5 py-3 font-medium">ETA</th>
              </tr>
            </thead>
            <tbody>
              {openOrders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-border last:border-0 hover:bg-bg"
                >
                  <td className="px-5 py-3 font-medium text-accent">
                    {order.id}
                  </td>
                  <td className="px-5 py-3 text-text">{order.partNumber}</td>
                  <td className="px-5 py-3 text-muted">{order.aircraft}</td>
                  <td className="px-5 py-3 text-muted">{order.vendor}</td>
                  <td className="px-5 py-3">
                    <Badge tone={statusTone(order.status)}>
                      {order.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        order.daysOpen > 14
                          ? 'font-medium text-danger'
                          : 'text-text'
                      }
                    >
                      {order.daysOpen}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-muted">{order.eta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
