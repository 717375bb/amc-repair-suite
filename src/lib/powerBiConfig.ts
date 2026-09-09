/**
 * PowerBI Reports — link-out config, per explicit user direction (2026-09-09).
 *
 * Real in-app embedding (a report rendering live inside the suite's own
 * window, no separate login) needs either Power BI Premium/Fabric capacity
 * (App owns data embedding) or an Azure AD App Registration for "embed for
 * your organization" (User owns data — works on a plain Pro license, but
 * still needs someone with Azure AD access to register an app and grant it
 * Power BI Service API delegated permissions). Neither is set up yet, so
 * this ships the simplest path that works today with zero external
 * dependency: real links that open in a new tab, using each analyst's own
 * PowerBI login (their existing Microsoft 365 session covers it in the
 * common case). Nothing here requires a backend change or new credentials.
 *
 * Once an Azure AD App Registration exists, this is the file to replace
 * with a real embedded-report component (`powerbi-client` + MSAL) — see
 * docs/DESKTOP_SHORTCUT_SETUP.md-style guides for the general shape; ask
 * for that build once the App Registration is in hand.
 *
 * HOW TO ADD/EDIT YOUR REPORTS: edit the two constants below directly —
 * no other file needs to change.
 */

/**
 * The PowerBI workspace/app URL — "log in and access the entire workspace"
 * per the original request. Point this at your actual workspace (Power BI
 * Service -> the workspace -> copy its URL from the address bar), or leave
 * the generic app.powerbi.com home if you'd rather land there and pick a
 * workspace from PowerBI's own nav.
 */
export const POWERBI_WORKSPACE_URL = 'https://app.powerbi.com/'

export interface PowerBiReportLink {
  name: string
  description?: string
  url: string
}

/**
 * Individual report shortcuts. Empty by default — add your own entries
 * here, e.g.:
 *   { name: 'Vendor Turnaround', url: 'https://app.powerbi.com/groups/.../reports/.../ReportSection' }
 * Get a report's URL from PowerBI: open the report in the browser, then
 * copy the address bar URL (or use PowerBI's own "Share" -> "Copy link").
 */
export const POWERBI_REPORTS: PowerBiReportLink[] = []
