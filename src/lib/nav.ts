import {
  ClipboardList,
  Mail,
  Table2,
  FileWarning,
  Wrench,
  PackageX,
  FileText,
  ShieldCheck,
  Gauge,
  LineChart,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  key: string
  path: string
  label: string
  description: string
  icon: LucideIcon
  /** Marks workflows that are scaffolded but not yet built out in detail. */
  status?: 'soon'
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

export const navGroups: NavGroup[] = [
  {
    label: 'Orders & Repairs',
    items: [
      {
        key: 'repair-orders',
        path: '/repair-orders',
        label: 'Repair Orders',
        description: 'Create and manage outgoing repair orders',
        icon: ClipboardList,
      },
      {
        key: 'open-orders',
        path: '/open-orders',
        label: 'Open Order Tracking',
        description: 'Track in-progress repair orders',
        icon: Table2,
      },
      {
        key: 'backshop-repairs',
        path: '/backshop-repairs',
        label: 'Backshop Repairs',
        description: 'Automate parts repaired in-house',
        icon: Wrench,
        status: 'soon',
      },
      {
        key: 'scrapped-parts',
        path: '/scrapped-parts',
        label: 'Scrapped Parts',
        description: 'Process and document parts scrapped from service',
        icon: PackageX,
        status: 'soon',
      },
    ],
  },
  {
    label: 'Quotes & Discrepancies',
    items: [
      {
        key: 'email-quotes',
        path: '/email-quotes',
        label: 'Email Quote Analysis',
        description: 'Review repair quotes received by email',
        icon: Mail,
      },
      {
        key: 'quotes-reports',
        path: '/quotes-reports',
        label: 'Quotes & Reports',
        description: 'Quote displays and other reporting',
        icon: FileText,
        status: 'soon',
      },
      {
        key: 'discrepancies',
        path: '/discrepancies',
        label: 'Discrepancies & Paperwork',
        description: 'Resolve receiving discrepancies and paperwork',
        icon: FileWarning,
      },
    ],
  },
  {
    label: 'Approvals',
    items: [
      {
        key: 'warranty-assessment',
        path: '/warranty-assessment',
        label: 'Warranty Assessment',
        description: 'Assess and approve order warranty eligibility',
        icon: ShieldCheck,
        status: 'soon',
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      {
        key: 'vendor-kpi',
        path: '/vendor-kpi',
        label: 'Vendor KPI Reports',
        description: 'One-click KPI reporting by vendor',
        icon: Gauge,
        status: 'soon',
      },
      {
        key: 'statistical-models',
        path: '/statistical-models',
        label: 'Statistical Models',
        description: 'Analytical and statistical models',
        icon: LineChart,
        status: 'soon',
      },
    ],
  },
]

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items)
