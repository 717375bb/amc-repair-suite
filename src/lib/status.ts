type Tone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral'

const toneByStatus: Record<string, Tone> = {
  'Pending Approval': 'warning',
  'Quote Received': 'accent',
  'Shipped to Vendor': 'accent',
  'In Repair': 'accent',
  'Awaiting Core Return': 'warning',
  Closed: 'neutral',
  Resolved: 'success',
  Approved: 'success',
  Open: 'danger',
  'Needs Review': 'warning',
  Negotiating: 'warning',
  'Pending Vendor Response': 'warning',
}

export function statusTone(status: string): Tone {
  return toneByStatus[status] ?? 'neutral'
}

const toneByPriority: Record<string, Tone> = {
  AOG: 'danger',
  Critical: 'warning',
  Routine: 'neutral',
}

export function priorityTone(priority: string): Tone {
  return toneByPriority[priority] ?? 'neutral'
}
