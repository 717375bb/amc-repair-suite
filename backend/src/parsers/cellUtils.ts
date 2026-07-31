import type { CellValue } from 'exceljs';

/**
 * Real-world exports sometimes leave a single space in "blank" cells, and
 * copy-pasted Notes fields carry literal _x000D_ carriage-return artifacts.
 * Every cell read from these workbooks should go through this function.
 */
export function cleanCell(value: CellValue): string | null {
  if (value === null || value === undefined) return null;

  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    const obj = value as unknown as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      str = (obj.richText as Array<{ text?: string }>).map((rt) => rt.text ?? '').join('');
    } else if ('result' in obj) {
      str = obj.result === null || obj.result === undefined ? '' : String(obj.result);
    } else if ('text' in obj) {
      str = String(obj.text ?? '');
    } else {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  str = str.replace(/_x000D_/g, '').trim();
  return str.length > 0 ? str : null;
}
