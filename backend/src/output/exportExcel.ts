import ExcelJS from 'exceljs';
import type { InferenceRecord } from '../types.js';

export async function exportExcel(records: InferenceRecord[], outputPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Output');

  sheet.columns = [
    { header: 'Order Number', key: 'orderNumber', width: 16 },
    { header: 'Vendor ESD', key: 'inferredEsd', width: 14 },
    { header: 'Current Status', key: 'currentStatus', width: 32 },
    { header: 'Vendor Notes', key: 'vendorNotes', width: 45 },
    { header: 'MXI ESD', key: 'mxiEsdRaw', width: 14 },
    { header: 'Notes', key: 'orderStatus', width: 20 },
    { header: 'ESD Match', key: 'esdMatch', width: 12 },
    { header: 'ESD Delta', key: 'deltaDaysVsMxi', width: 12 },
    { header: 'Classification', key: 'classification', width: 20 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Flag', key: 'flag', width: 20 },
    { header: 'Reasoning Note', key: 'reasoningNote', width: 55 },
  ];

  for (const record of records) {
    sheet.addRow({
      orderNumber: record.orderNumber,
      inferredEsd: record.inferredEsd,
      currentStatus: record.currentStatus,
      vendorNotes: record.vendorNotes,
      mxiEsdRaw: record.mxiEsdRaw,
      orderStatus: record.orderStatus,
      esdMatch: record.deltaDaysVsMxi === null ? '' : record.deltaDaysVsMxi === 0 ? 'Yes' : 'No',
      deltaDaysVsMxi: record.deltaDaysVsMxi,
      classification: record.classification,
      confidence: record.confidence,
      flag: record.flag,
      reasoningNote: record.reasoningNote,
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: 'L1' };

  await workbook.xlsx.writeFile(outputPath);
}
