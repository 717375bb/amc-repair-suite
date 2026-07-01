import { Wrench } from 'lucide-react'
import { WorkflowPlaceholder } from '../components/WorkflowPlaceholder'

export default function BackshopRepairs() {
  return (
    <div data-workflow="backshop-repairs">
      <WorkflowPlaceholder
        icon={Wrench}
        title="Backshop Repairs"
        description="Parts repaired in-house instead of being sent to an outside vendor follow a different process than standard repair orders, though the interface will feel similar."
        scope={[
          'Track parts routed to in-house backshop repair instead of a vendor',
          'Mirror the repair order workflow with backshop-specific steps',
          'Automation hooks for technician assignment and parts consumption',
        ]}
      />
    </div>
  )
}
