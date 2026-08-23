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
  PlayCircle,
  Search,
  DollarSign,
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
        description: 'Scrap at vendor from a certificate, or in-house by serial',
        icon: PackageX,
      },
      {
        key: 'order-write-ups',
        path: '/order-write-ups',
        label: 'Order Write-Ups',
        description: 'Run and review automated vendor write-ups',
        icon: PlayCircle,
      },
      {
        key: 'esd-finder',
        path: '/esd-finder',
        label: 'Open Order ESD Finder',
        description: 'Drag in vendor/CRA OOR files and review inferred ESDs',
        icon: Search,
      },
      {
        key: 'invoice-price-writer',
        path: '/invoice-price-writer',
        label: 'Invoice Price Writer',
        description: 'Update MXI price lines from a weekly billing/invoice sheet',
        icon: DollarSign,
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
        description: 'Read vendor quote PDFs from your Outlook Quotes folder',
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
