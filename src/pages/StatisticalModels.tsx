import { LineChart } from 'lucide-react'
import { WorkflowPlaceholder } from '../components/WorkflowPlaceholder'

export default function StatisticalModels() {
  return (
    <div data-workflow="statistical-models">
      <WorkflowPlaceholder
        icon={LineChart}
        title="Statistical Models"
        description="A home for analytical and statistical models supporting repair operations."
        scope={[
          'House various statistical models as they are defined',
          'May include KPI dashboards and trend analysis',
          'Specific models still being scoped',
        ]}
      />
    </div>
  )
}
