import {
  Mail,
  Wrench,
  PackageX,
  PlayCircle,
  Search,
  DollarSign,
  LayoutGrid,
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
    label: 'Quotes',
    items: [
      {
        key: 'email-quotes',
        path: '/email-quotes',
        label: 'Email Quote Analysis',
        description: 'Read vendor quote PDFs from your Outlook Quotes folder',
        icon: Mail,
      },
    ],
  },
  {
    label: 'Analytics',
    items: [
      {
        key: 'powerbi-reports',
        path: '/powerbi-reports',
        label: 'PowerBI Reports',
        description: 'Open your PowerBI workspace and individual reports',
        icon: LayoutGrid,
      },
    ],
  },
]

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items)
