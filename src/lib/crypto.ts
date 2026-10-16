import crypto from "node:crypto";

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (v: string | Buffer) => crypto.createHash("sha256").update(v).digest("hex");
export function hmacHex(secret: string, data: string) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
