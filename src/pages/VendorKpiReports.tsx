import { Gauge } from 'lucide-react'
import { WorkflowPlaceholder } from '../components/WorkflowPlaceholder'

export default function VendorKpiReports() {
  return (
    <div data-workflow="vendor-kpi">
      <WorkflowPlaceholder
        icon={Gauge}
        title="Vendor KPI Reports"
        description="Easily produced, one-click KPI reports for vendor performance."
        scope={[
          'One-click KPI report generation per vendor',
          'Turnaround time, quote accuracy, and cost benchmarks',
          'Reporting cadence and exact KPIs to be defined',
        ]}
      />
    </div>
  )
}
