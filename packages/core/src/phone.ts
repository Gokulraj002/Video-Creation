/**
 * Normalizes a phone number to WhatsApp's format: country code + number, digits only.
 * Bare 10-digit numbers (and 0-prefixed 11-digit ones) get the default country code.
 */
export function normalizePhone(raw: string, defaultCountryCode: string): string | null {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (trimmed.startsWith('+') || digits.startsWith('00')) {
    digits = digits.replace(/^00/, '');
  } else if (digits.length === 10) {
    digits = defaultCountryCode + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1);
  }

  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}
