import { ShieldCheck } from 'lucide-react'
import { WorkflowPlaceholder } from '../components/WorkflowPlaceholder'

export default function WarrantyAssessment() {
  return (
    <div data-workflow="warranty-assessment">
      <WorkflowPlaceholder
        icon={ShieldCheck}
        title="Warranty Assessment"
        description="Assess and approve repair orders for warranty eligibility before they're sent out."
        scope={[
          'Evaluate orders for warranty eligibility before repair begins',
          'Approval workflow with sign-off tracking',
          'Link to vendor warranty terms and part repair history',
        ]}
      />
    </div>
  )
}
