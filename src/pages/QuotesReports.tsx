import { FileText } from 'lucide-react'
import { WorkflowPlaceholder } from '../components/WorkflowPlaceholder'

export default function QuotesReports() {
  return (
    <div data-workflow="quotes-reports">
      <WorkflowPlaceholder
        icon={FileText}
        title="Quotes & Reports"
        description="A broader home for quote displays and other reports, expanding on the email quote analysis workflow."
        scope={[
          'Centralized view of repair quotes across vendors and orders',
          'Ad hoc and recurring report generation',
          'Exact report types still being scoped',
        ]}
      />
    </div>
  )
}
