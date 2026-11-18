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

/** A US/CA number the way recruiters write it: (336) 837-7237. Other numbers stay as they are. */
export function displayPhone(e164: string | null | undefined) {
  const m = e164?.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 ?? "";
}
