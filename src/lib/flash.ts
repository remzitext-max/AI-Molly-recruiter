// One-shot "toast" message from a server action to the next render, carried in a
// short-lived cookie. The layout reads it and the client Toaster shows it once.
import { cookies } from "next/headers";

export type Flash = { id: string; message: string; tone: "ok" | "error" | "info" };

export async function flash(message: string, tone: Flash["tone"] = "ok") {
  const value: Flash = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message, tone };
  (await cookies()).set("flash", encodeURIComponent(JSON.stringify(value)), { path: "/", maxAge: 60, sameSite: "lax" });
}

export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get("flash")?.value;
  if (!raw) return null;
  try { return JSON.parse(decodeURIComponent(raw)) as Flash; } catch { return null; }
}
