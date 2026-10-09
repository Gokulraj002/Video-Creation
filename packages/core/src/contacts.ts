import { parse } from 'csv-parse/sync';
import { normalizePhone } from './phone';
import type { Vars } from './types';

export interface ParsedContact {
  name: string | null;
  phone: string;
  vars: Vars;
}

export interface ParseResult {
  contacts: ParsedContact[];
  invalid: { row: number; reason: string }[];
}

const PHONE_HEADERS = ['phone', 'mobile', 'number', 'whatsapp', 'phone_number'];

/**
 * Parses a contacts CSV. Needs a phone column (phone/mobile/number/whatsapp);
 * `name` is optional and every other column becomes a template variable.
 */
export function parseContactsCsv(csv: string | Buffer, defaultCountryCode: string): ParseResult {
  const records = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const contacts: ParsedContact[] = [];
  const invalid: ParseResult['invalid'] = [];
  const seen = new Set<string>();

  records.forEach((record, i) => {
    const row = i + 2; // header is row 1
    const phoneKey = PHONE_HEADERS.find((h) => record[h] !== undefined);
    if (!phoneKey) {
      invalid.push({ row, reason: 'missing phone column' });
      return;
    }

    const phone = normalizePhone(record[phoneKey] ?? '', defaultCountryCode);
    if (!phone) {
      invalid.push({ row, reason: `invalid phone "${record[phoneKey]}"` });
      return;
    }
    if (seen.has(phone)) {
      invalid.push({ row, reason: `duplicate phone ${phone}` });
      return;
    }
    seen.add(phone);

    const { [phoneKey]: _phone, ...rest } = record;
    const name = rest.name?.trim() || null;
    contacts.push({ name, phone, vars: { ...rest, phone } });
  });

  return { contacts, invalid };
}
