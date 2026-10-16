import { db } from "@/lib/db";
import { config } from "@/lib/config";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const stuck = await db.job.count({ where: { status: "PENDING", runAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
    return Response.json({ ok: true, mode: config.mode, overdueJobs: stuck });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
