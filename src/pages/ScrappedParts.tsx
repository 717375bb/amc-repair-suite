import { PackageX } from 'lucide-react'
import { WorkflowPlaceholder } from '../components/WorkflowPlaceholder'

export default function ScrappedParts() {
  return (
    <div data-workflow="scrapped-parts">
      <WorkflowPlaceholder
        icon={PackageX}
        title="Scrapped Parts"
        description="Processing for parts that are removed from service as scrap rather than repaired."
        scope={[
          'Document parts scrapped from service with reason and approval',
          'Link scrap dispositions back to the originating repair order',
          'Track scrap-related paperwork through to closure',
        ]}
      />
    </div>
  )
}
