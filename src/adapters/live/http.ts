import { UncertainOutcomeError } from "../types";

/**
 * fetch wrapper. Distinguishes "request definitely rejected" (4xx -> Error)
 * from "outcome unknown" (timeout / network / 5xx -> UncertainOutcomeError)
 * so callers reconcile before retrying anything that contacts a person.
 */
export async function providerFetch(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new UncertainOutcomeError(`Network error or timeout calling provider: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 500) throw new UncertainOutcomeError(`Provider returned ${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Provider rejected request (${res.status}): ${body.slice(0, 300)}`);
  }
  return res;
}
