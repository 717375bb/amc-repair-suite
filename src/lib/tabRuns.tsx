import {
  getActiveQuoteJob,
  getQuoteRun,
  cancelQuoteRun,
  type QuoteRunStatusResponse,
} from './quoteApi'
import {
  getActiveScrapJob,
  getScrapRun,
  cancelScrapRun,
  type ScrapRunStatusResponse,
} from './scrapApi'
import {
  getActiveInvoicePriceJob,
  getInvoicePriceRunStatus,
  cancelInvoicePriceRun,
  type InvoicePriceRunStatusResponse,
} from './invoicePriceWriterApi'
import { createTrackedRun } from './trackedRun'

/**
 * The three tabs that previously kept their run in page-local state, now
 * each backed by the shared tracker so their runs survive navigation and
 * report into the sidebar registry.
 *
 * Each supplies its own progress derivation, because the tabs count
 * genuinely different things and the badge should say what that tab means
 * rather than a lowest-common-denominator number.
 */

export const QuoteRun = createTrackedRun<QuoteRunStatusResponse>('/email-quotes', 'Quote', {
  getActive: getActiveQuoteJob,
  getRun: getQuoteRun,
  cancelRun: cancelQuoteRun,
})

export const ScrapRun = createTrackedRun<ScrapRunStatusResponse>('/scrapped-parts', 'Scrap', {
  getActive: getActiveScrapJob,
  getRun: getScrapRun,
  cancelRun: cancelScrapRun,
  // The in-house path takes several serials at once, so "N of M" is real
  // information here rather than a spinner.
  progressOf: (run) => ({ done: run.results?.length, total: run.totalRequested }),
})

export const InvoicePriceRun = createTrackedRun<InvoicePriceRunStatusResponse>(
  '/invoice-price-writer',
  'InvoicePrice',
  {
    getActive: getActiveInvoicePriceJob,
    getRun: getInvoicePriceRunStatus,
    cancelRun: cancelInvoicePriceRun,
  },
)
