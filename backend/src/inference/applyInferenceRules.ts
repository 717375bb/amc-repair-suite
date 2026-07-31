import { addDays, differenceInCalendarDays, formatISO, isBefore, parseISO, startOfDay } from 'date-fns';
import type { EsdClassification, EsdFlag, InferenceRecord, MatchedOrder, MatchFlag, RunSummary } from '../types.js';
import { PARTS_PENDING_FALLBACK_DAYS, QUOTE_BUFFER_DAYS, SHIPPING_BUFFER_DAYS } from './constants.js';
import { parseFlexibleDate } from './dateUtils.js';
import type { EsdInferenceProvider } from './types.js';

interface BaseFields {
  orderNumber: string;
  vendorName: string | null;
  roEsdRaw: string | null;
  mxiEsdRaw: string | null;
  currentStatus: string | null;
  vendorNotes: string | null;
  orderStatus: string | null;
}

interface ComputedFields {
  classification: EsdClassification | null;
  extractedBaseDate: string | null;
  bufferDaysApplied: number | null;
  usedFallback: boolean;
  confidence: 'high' | 'medium' | 'low' | null;
  reasoningNote: string | null;
  inferredEsd: Date | null;
  aiCallMade: boolean;
}

function emptySummary(processed: number): RunSummary {
  return {
    processed,
    matched: 0,
    orphanedVendor: 0,
    orphanedCra: 0,
    aiCallsMade: 0,
    aiFallbackUsed: 0,
  };
}

export async function applyInferenceRules(
  matchedOrders: MatchedOrder[],
  provider: EsdInferenceProvider,
  today: Date = new Date(),
): Promise<{ records: InferenceRecord[]; summary: RunSummary }> {
  const summary = emptySummary(matchedOrders.length);
  const todayStart = startOfDay(today);
  const records: InferenceRecord[] = [];

  for (const order of matchedOrders) {
    if (order.flag === 'ok') summary.matched++;
    else if (order.flag === 'orphaned_vendor_row') summary.orphanedVendor++;
    else if (order.flag === 'orphaned_cra_row') summary.orphanedCra++;

    records.push(await processOrder(order, provider, todayStart, summary));
  }

  return { records, summary };
}

async function processOrder(
  order: MatchedOrder,
  provider: EsdInferenceProvider,
  todayStart: Date,
  summary: RunSummary,
): Promise<InferenceRecord> {
  const base: BaseFields = {
    orderNumber: order.orderNumber,
    vendorName: order.vendor?.vendorName ?? order.cra?.vendorName ?? null,
    roEsdRaw: order.vendor?.roEsd ?? null,
    mxiEsdRaw: order.cra?.mxiRoEsd ?? null,
    currentStatus: order.vendor?.currentStatus ?? null,
    vendorNotes: order.vendor?.vendorNotes ?? null,
    orderStatus: order.cra?.orderStatus ?? null,
  };

  // No vendor data at all (orphaned_cra_row) — nothing to run inference on.
  if (!order.vendor) {
    return finalizeRecord(
      base,
      {
        classification: null,
        extractedBaseDate: null,
        bufferDaysApplied: null,
        usedFallback: false,
        confidence: null,
        reasoningNote: null,
        inferredEsd: null,
        aiCallMade: false,
      },
      order.flag,
      todayStart,
    );
  }

  // Step 1 — trust the structured RO ESD field directly when it's parseable.
  const roEsdDate = parseFlexibleDate(base.roEsdRaw);
  if (roEsdDate) {
    return finalizeRecord(
      base,
      {
        classification: 'explicit_date',
        extractedBaseDate: formatISO(roEsdDate, { representation: 'date' }),
        bufferDaysApplied: SHIPPING_BUFFER_DAYS,
        usedFallback: false,
        confidence: 'high',
        reasoningNote: 'RO ESD field contained a parseable date; trusted directly per Step 1.',
        inferredEsd: addDays(roEsdDate, SHIPPING_BUFFER_DAYS),
        aiCallMade: false,
      },
      order.flag,
      todayStart,
    );
  }

  // Step 2 — RO ESD is blank; call the AI on the free text.
  summary.aiCallsMade++;
  const aiResult = await provider.infer({
    orderNumber: order.orderNumber,
    vendorName: base.vendorName,
    currentStatus: base.currentStatus,
    vendorNotes: base.vendorNotes,
  });

  // Step 3 — apply the offset deterministically, in code.
  const extractedBaseDate = aiResult.extractedBaseDate
    ? parseFlexibleDate(aiResult.extractedBaseDate)
    : null;

  let inferredEsd: Date | null = null;
  let bufferDaysApplied: number | null = null;
  let usedFallback = false;

  if (extractedBaseDate) {
    if (aiResult.classification === 'explicit_date') {
      bufferDaysApplied = SHIPPING_BUFFER_DAYS;
      inferredEsd = addDays(extractedBaseDate, SHIPPING_BUFFER_DAYS);
    } else if (aiResult.classification === 'vendor_quote_estimate') {
      bufferDaysApplied = QUOTE_BUFFER_DAYS;
      inferredEsd = addDays(extractedBaseDate, QUOTE_BUFFER_DAYS);
    } else if (aiResult.classification === 'parts_pending') {
      let offset = aiResult.suggestedPartsPendingOffsetDays;
      if (offset === null || offset === undefined) {
        offset = PARTS_PENDING_FALLBACK_DAYS;
        usedFallback = true;
      }
      bufferDaysApplied = offset;
      inferredEsd = addDays(extractedBaseDate, offset);
    }
  }

  if (usedFallback) summary.aiFallbackUsed++;

  // Deterministic override, not just prompt instruction: these two
  // classifications never carry a computable/relevant date, regardless of
  // what the AI returns — same "don't trust one layer" discipline as the
  // rest of Step 3's offset logic below.
  const isDatelessClassification =
    aiResult.classification === 'not_esd_relevant' || aiResult.classification === 'quote_sent_reference';

  return finalizeRecord(
    base,
    {
      classification: aiResult.classification,
      extractedBaseDate: isDatelessClassification ? null : aiResult.extractedBaseDate,
      bufferDaysApplied,
      usedFallback,
      confidence: aiResult.confidence,
      reasoningNote: aiResult.reasoningNote,
      inferredEsd,
      aiCallMade: true,
    },
    order.flag,
    todayStart,
  );
}

function finalizeRecord(
  base: BaseFields,
  computed: ComputedFields,
  matchFlag: MatchFlag,
  todayStart: Date,
): InferenceRecord {
  let flag: EsdFlag = matchFlag;
  let inferredEsdIso: string | null = null;

  if (computed.inferredEsd) {
    // Step 4 — sanity check regardless of source: a stale computed date is
    // worse than admitting we don't know. Keep the raw classification and
    // extracted date in the audit record even when overridden.
    if (isBefore(computed.inferredEsd, todayStart)) {
      if (matchFlag === 'ok') {
        flag = 'no_esd_found';
      }
    } else {
      inferredEsdIso = formatISO(computed.inferredEsd, { representation: 'date' });
    }
  } else if (matchFlag === 'ok') {
    flag = 'no_esd_found';
  }

  let deltaDaysVsMxi: number | null = null;
  if (inferredEsdIso) {
    const mxiDate = parseFlexibleDate(base.mxiEsdRaw);
    if (mxiDate) {
      deltaDaysVsMxi = differenceInCalendarDays(parseISO(inferredEsdIso), mxiDate);
    }
  }

  return {
    ...base,
    classification: computed.classification,
    extractedBaseDate: computed.extractedBaseDate,
    bufferDaysApplied: computed.bufferDaysApplied,
    usedFallback: computed.usedFallback,
    confidence: computed.confidence,
    reasoningNote: computed.reasoningNote,
    inferredEsd: inferredEsdIso,
    flag,
    deltaDaysVsMxi,
    aiCallMade: computed.aiCallMade,
  };
}
