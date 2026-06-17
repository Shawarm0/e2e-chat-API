import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function validateAndNormalizePhone(
  input: string,
): { valid: true; e164: string } | { valid: false; reason: string } {
  const parsed = parsePhoneNumberFromString(input);
  if (!parsed || !parsed.isValid()) {
    return { valid: false, reason: 'Invalid phone number' };
  }
  return { valid: true, e164: parsed.format('E.164') };
}
