import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, PageHead, fmt } from "@/components/ui";
import { flash } from "@/lib/flash";
import { createTeam, updateTeam } from "@/lib/teams";
import { teamConnId } from "@/lib/team-sheets";

const SERVICE_ACCOUNT = "molly-sheets@snappy-mission-512222-d2.iam.gserviceaccount.com";
const g = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const sheetLinkOf = (o: { sheetSpreadsheetId: string | null; sheetPoolTab: string | null }) =>
  o.sheetSpreadsheetId ? `https://docs.google.com/spreadsheets/d/${o.sheetSpreadsheetId}/edit${o.sheetPoolTab?.startsWith("gid:") ? `#gid=${o.sheetPoolTab.slice(4)}` : ""}` : "";
const SETUP_NOTE = "Run telnyx-setup on the server once so Crystal can transfer to the new number";

async function create(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const r = await createTeam(u, {
    name: g(fd, "name"), managerName: g(fd, "managerName"), managerEmail: g(fd, "managerEmail"), password: g(fd, "password"),
    sheetLink: g(fd, "sheetLink"), transferPhone: g(fd, "transferPhone"), telegramChatId: g(fd, "telegramChatId"),
  });
  if ("error" in r) redirect(`/teams?error=${encodeURIComponent(r.error!)}`);
  await flash(`Team created. ${g(fd, "transferPhone").trim() ? SETUP_NOTE : "Add the team's transfer number when you have it"}`);
  revalidatePath("/teams");
}

async function save(fd: FormData) {
  "use server";
  const u = await requireOwner();
  const r = await updateTeam(u, g(fd, "id"), { name: g(fd, "name"), sheetLink: g(fd, "sheetLink"), transferPhone: g(fd, "transferPhone"), telegramChatId: g(fd, "telegramChatId") });
  if ("error" in r) redirect(`/teams?error=${encodeURIComponent(r.error!)}`);
  await flash(r.transferChanged ? `Saved. ${SETUP_NOTE}` : "Your changes are saved");
  revalidatePath("/teams");
}

export default async function Teams({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireOwner();
  const sp = await searchParams;
  const teams = await db.organization.findMany({ where: { isMain: false }, orderBy: { createdAt: "asc" }, include: { _count: { select: { leads: true } }, users: { orderBy: { createdAt: "asc" }, select: { name: true, email: true, role: true } } } });
  const conns = new Map((await db.sourceConnection.findMany({ where: { id: { in: teams.map((t) => teamConnId(t.id)) } } })).map((c) => [c.orgId, c]));
  return (
    <>
      <PageHead title="Teams" sub="Other recruiting teams on this site. Their logins see only their own leads and dashboard, never yours. Crystal calls their new leads the same way, in the company's name, and transfers their drivers to the team's own number." />
      {sp.error && <div className="alert error">{sp.error}</div>}
      {teams.map((t) => {
        const c = conns.get(t.id);
        const summary = c?.lastSummary as { baselineRows?: number; checkedRows?: number; imported?: Record<string, number> | null } | null;
        return (
          <Card key={t.id} title={t.name} right={<span className="small muted">{t._count.leads} leads · {t.users.length} logins</span>}>
            <p className="small">
              Logins: {t.users.map((x) => `${x.name} (${x.email}${x.role === "ADMIN" ? ", manager" : ""})`).join(", ")}. The manager adds the team&apos;s recruiters on their Users page.
            </p>
            <p className="small muted">
              Sheet: {!t.sheetSpreadsheetId ? "not set" : c?.lastError ? <span className="bad-text">{c.lastError}</span>
                : summary?.baselineRows !== undefined ? `connected, ${summary.baselineRows} rows already in the Pool were left alone; new rows will be called`
                : summary?.checkedRows !== undefined ? `read ${fmt(c?.lastSyncAt)}, ${summary.checkedRows} rows in the Pool` : "waiting for the first read"}
              {t.transferPhoneE164 ? ` · Transfers to ${t.transferPhoneE164}` : " · No transfer number yet"}
              {t.telegramChatId ? " · Own Telegram group" : " · No Telegram group (nothing of theirs goes to Telegram)"}
            </p>
            <form action={save}>
              <input type="hidden" name="id" value={t.id} />
              <div className="grid two">
                <div><label>Team name</label><input name="name" defaultValue={t.name} required autoComplete="off" /></div>
                <div><label>Lead sheet link (open the Pool tab, copy the address)</label><input name="sheetLink" defaultValue={sheetLinkOf(t)} autoComplete="off" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" /></div>
                <div><label>Transfer number (driver asks for a person)</label><input name="transferPhone" type="tel" defaultValue={t.transferPhoneE164 ?? ""} autoComplete="off" placeholder="+1…" /></div>
                <div><label>Telegram group chat id (optional)</label><input name="telegramChatId" defaultValue={t.telegramChatId ?? ""} autoComplete="off" placeholder="-100…" /></div>
              </div>
              <div style={{ marginTop: 12 }}><button className="secondary">Save</button></div>
            </form>
          </Card>
        );
      })}
      <Card title="Add a team">
        <form action={create}>
          <div className="grid two">
            <div><label>Team name *</label><input name="name" required autoComplete="off" placeholder="First team" /></div>
            <div><label>Lead sheet link (open the Pool tab, copy the address)</label><input name="sheetLink" autoComplete="off" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" /></div>
            <div><label>Manager&apos;s name *</label><input name="managerName" required autoComplete="off" /></div>
            <div><label>Manager&apos;s login email *</label><input name="managerEmail" type="email" required autoComplete="off" /></div>
            <div><label>Temporary password (12+) *</label><input name="password" type="password" required autoComplete="new-password" /></div>
            <div><label>Transfer number (driver asks for a person)</label><input name="transferPhone" type="tel" autoComplete="off" placeholder="+1…" /></div>
            <div><label>Telegram group chat id (optional)</label><input name="telegramChatId" autoComplete="off" placeholder="-100…" /></div>
          </div>
          <p className="small muted">Share the sheet with {SERVICE_ACCOUNT} as Viewer first. Leads already in the Pool are not called; only rows added after the team is saved. A driver who is already your lead stays yours and is not called twice. The team gets a copy of your campaign (same offer, hours and retries).</p>
          <div style={{ marginTop: 12 }}><button>Create team</button></div>
        </form>
      </Card>
    </>
  );
}
