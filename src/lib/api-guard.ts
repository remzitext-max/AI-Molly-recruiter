// Guards for JSON endpoints the site's own pages call with the session cookie.
import { currentUser } from "./auth";

/** The signed-in user for a same-origin request, or a Response to return instead. */
export async function apiUser(req: Request) {
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin && new URL(origin).host !== req.headers.get("host")) return new Response("Forbidden", { status: 403 });
  const u = await currentUser();
  if (!u || !u.active) return new Response("Unauthorized", { status: 401 });
  return u;
}
