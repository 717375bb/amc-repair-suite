import { Plus, Search } from 'lucide-react'
import { Badge, Card, CardHeader, PrimaryButton } from '../components/ui'
import { repairOrders } from '../data/mockData'
import { priorityTone, statusTone } from '../lib/status'

export default function RepairOrders() {
  return (
    <div className="space-y-5" data-workflow="repair-orders">
      <div className="flex items-center justify-between">
        <div className="relative w-72">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="text"
            placeholder="Search by RO #, part number, vendor..."
            className="w-full rounded-md border border-border bg-surface py-2 pl-9 pr-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <PrimaryButton>
          <Plus size={16} />
          New Repair Order
        </PrimaryButton>
      </div>

      <Card>
        <CardHeader
          title="All Repair Orders"
          description={`${repairOrders.length} orders shown`}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-medium">RO #</th>
                <th className="px-5 py-3 font-medium">Part Number</th>
                <th className="px-5 py-3 font-medium">Description</th>
                <th className="px-5 py-3 font-medium">Vendor</th>
                <th className="px-5 py-3 font-medium">Priority</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {repairOrders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-border last:border-0 hover:bg-bg"
                >
                  <td className="px-5 py-3 font-medium text-accent">
                    {order.id}
                  </td>
                  <td className="px-5 py-3 text-text">{order.partNumber}</td>
                  <td className="px-5 py-3 text-text">{order.description}</td>
                  <td className="px-5 py-3 text-muted">{order.vendor}</td>
                  <td className="px-5 py-3">
                    <Badge tone={priorityTone(order.priority)}>
                      {order.priority}
                    </Badge>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={statusTone(order.status)}>
                      {order.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-muted">
                    {order.dateCreated}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
