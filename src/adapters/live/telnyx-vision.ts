// Reads a CDL or DOT medical card photo with a vision model on Telnyx inference
// (OpenAI-compatible POST /v2/ai/openai/chat/completions). Fields are a recruiter
// aid and always marked for human review; the full license number is never kept.
// Not yet verified on a live document: the model must accept image input.
import { config } from "../../lib/config";
import { providerFetch } from "./http";
import type { DocumentExtractor, ExtractedField, IntegrationStatus } from "../types";

const URL_ = "https://api.telnyx.com/v2/ai/openai/chat/completions";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const KEYS = ["doc_type", "full_name", "license_class", "state", "license_last4", "expiration_date", "endorsements", "restrictions"] as const;

const PROMPT = `This is a photo a truck driver sent of their CDL (commercial driver's license) or DOT medical examiner's certificate (medical card). Return ONLY a JSON object with these keys, using null for anything you cannot read clearly:
- doc_type: "CDL", "medical card", or "other"
- full_name: the name printed on it
- license_class: CDL class letter (A, B or C), CDL only
- state: issuing state, two letters
- license_last4: last 4 characters of the license number only
- expiration_date: YYYY-MM-DD (for a medical card, the certificate expiration date)
- endorsements: endorsement letters, e.g. "H N T"
- restrictions: restriction codes or text
Never return the full license number or the date of birth.`;

/** The JSON object in a model reply, keeping only known keys. Exported for tests. */
export function parseDocFields(content: string): Record<string, string> {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return {};
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(m[0]); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() && !/^(null|unknown|n\/a|none)$/i.test(v.trim())) out[k] = v.trim().slice(0, 80);
  }
  if (out.license_last4) out.license_last4 = out.license_last4.replace(/\s/g, "").slice(-4);
  return out;
}

export class TelnyxVisionExtractor implements DocumentExtractor {
  key = "telnyx-vision";
  status(): IntegrationStatus {
    return {
      kind: "extraction", provider: "Telnyx inference (vision)", isMock: false, state: config.telnyx.apiKey ? "configured" : "missing_credentials",
      detail: `Reads CDL / medical card photos with ${this.model()}. Every value needs human review. Not yet verified with a live document.`,
    };
  }
  private model() { return process.env.TELNYX_VISION_MODEL || "moonshotai/Kimi-K2.6"; }
  async extract(data: Buffer, mimeType: string): Promise<{ fields: ExtractedField[]; warnings: string[]; docType?: string }> {
    if (!IMAGE_TYPES.includes(mimeType)) return { fields: [], warnings: [`${mimeType} files are not read automatically; review by hand.`] };
    const res = await providerFetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, "Content-Type": "application/json" },
      timeoutMs: 90_000,
      body: JSON.stringify({
        model: this.model(), temperature: 0, max_tokens: 600, enable_thinking: false,
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` } }] }],
      }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const got = parseDocFields(body.choices?.[0]?.message?.content ?? "");
    const fields = KEYS.filter((k) => k !== "doc_type" && got[k]).map((k) => ({ name: k, value: got[k], confidence: 0.7, uncertain: true }));
    return { fields, docType: got.doc_type, warnings: ["Read by AI from a photo: check against the document before relying on it."] };
  }
}
