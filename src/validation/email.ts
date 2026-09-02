import { z } from 'zod';

const emailSchema = z.email().max(254);

// Addresses are compared case-insensitively, so the normalised form is what
// gets stored and what the unique index sees.
export function validateAndNormalizeEmail(
  input: string,
): { valid: true; email: string } | { valid: false; reason: string } {
  const normalized = input.trim().toLowerCase();
  const parsed = emailSchema.safeParse(normalized);
  if (!parsed.success) {
    return { valid: false, reason: 'Invalid email address' };
  }
  return { valid: true, email: parsed.data };
}
