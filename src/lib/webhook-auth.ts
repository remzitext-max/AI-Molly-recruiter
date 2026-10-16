// Generic HMAC webhook verification with replay protection.
// Header: x-molly-signature: t=<unix-ms>,v1=<hex(HMAC_SHA256(secret, t + "." + rawBody))>
import { hmacHex, safeEqual } from "./crypto";

export const TOLERANCE_MS = 5 * 60 * 1000;

export function signPayload(secret: string, rawBody: string, t = Date.now()) {
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

export function verifySignature(secret: string | undefined, rawBody: string, header: string | null, now = Date.now()): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: "Webhook secret not configured" };
  if (!header) return { ok: false, reason: "Missing signature" };
  const m = header.match(/t=(\d+),v1=([a-f0-9]{64})/);
  if (!m) return { ok: false, reason: "Malformed signature" };
  const t = Number(m[1]);
  if (Math.abs(now - t) > TOLERANCE_MS) return { ok: false, reason: "Signature timestamp outside tolerance (possible replay)" };
  return safeEqual(hmacHex(secret, `${t}.${rawBody}`), m[2]) ? { ok: true } : { ok: false, reason: "Bad signature" };
}
