import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Normalize a US/CA phone number to E.164. Returns null when invalid. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  const p = parsePhoneNumberFromString(cleaned, "US");
  if (!p || !p.isValid()) return null;
  return p.number;
}

export function maskPhone(e164: string) {
  return e164.length > 4 ? `${"•".repeat(Math.max(0, e164.length - 4))}${e164.slice(-4)}` : e164;
}
