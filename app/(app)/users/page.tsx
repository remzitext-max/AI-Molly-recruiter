import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { recordEvent } from "@/lib/activity";
import { Badge, Card } from "@/components/ui";
import { flash } from "@/lib/flash";
import { ConfirmButton } from "@/components/confirm-button";
import { assignFromSheetTabs } from "@/lib/assignment";

const tabOf = (fd: FormData) => String(fd.get("sheetTab") || "").trim().slice(0, 100) || null;

/** Leads already sitting in this tab of the lead sheet go to its recruiter. */
async function claimTab(tab: string | null) {
  if (!tab) return 0;
  const rows = await db.sheetLeadStatus.findMany({ where: { tab: { equals: tab, mode: "insensitive" } }, select: { phoneE164: true, tab: true } });
  return assignFromSheetTabs(rows);
}

async function createUser(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const email = String(fd.get("email") || "").toLowerCase().trim();
  const pw = String(fd.get("password") || "");
  if (!email || pw.length < 12) redirect("/users?error=Email and a password of at least 12 characters are required");
  if (await db.user.findUnique({ where: { email } })) redirect("/users?error=Email already exists");
  const sheetTab = tabOf(fd);
  await db.user.create({ data: { orgId: u.orgId, email, name: String(fd.get("name") || email), role: fd.get("role") === "ADMIN" ? "ADMIN" : "RECRUITER", passwordHash: await hashPassword(pw), sheetTab } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "USER_CREATED", message: `User ${email} created` });
  const n = await claimTab(sheetTab);
  await flash(n ? `User created. ${n} leads from the ${sheetTab} tab assigned to them` : "User created");
  revalidatePath("/users");
}

async function updateUser(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const id = String(fd.get("id"));
  const target = await db.user.findFirstOrThrow({ where: { id, orgId: u.orgId } });
  const phone = String(fd.get("transferPhone") || "").trim();
  const active = fd.get("active") === "on";
  if (target.id === u.id && !active) redirect("/users?error=You cannot deactivate yourself");
  await db.user.update({
    where: { id },
    data: {
      role: fd.get("role") === "ADMIN" ? "ADMIN" : "RECRUITER", active, inRoundRobin: fd.get("rr") === "on", availableForTransfer: fd.get("avail") === "on",
      transferPhoneE164: phone ? normalizePhone(phone) : null, sheetTab: tabOf(fd),
    },
  });
  const claimed = tabOf(fd) && tabOf(fd)?.toLowerCase() !== target.sheetTab?.toLowerCase() ? await claimTab(tabOf(fd)) : 0;
  if (!active) await db.session.deleteMany({ where: { userId: id } });
  if (String(fd.get("password") || "").length >= 12) await db.user.update({ where: { id }, data: { passwordHash: await hashPassword(String(fd.get("password"))) } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "USER_UPDATED", message: `User ${target.email} updated` });
  await flash(claimed ? `Saved. ${claimed} leads from the ${tabOf(fd)} tab assigned to ${target.name}` : "Your changes are saved");
  revalidatePath("/users");
}

async function deleteUser(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const target = await db.user.findFirstOrThrow({ where: { id: String(fd.get("id")), orgId: u.orgId } });
  if (target.id === u.id) redirect("/users?error=You cannot delete yourself");
  // Their leads and tasks stay; they become unassigned so an admin can hand them to someone else.
  const leads = await db.lead.updateMany({ where: { assignedToId: target.id }, data: { assignedToId: null } });
  await db.task.updateMany({ where: { assignedToId: target.id }, data: { assignedToId: null } });
  await db.user.delete({ where: { id: target.id } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "USER_DELETED", message: `User ${target.email} deleted (${leads.count} leads unassigned)` });
  await flash(`${target.name} deleted. ${leads.count} leads are now unassigned`);
  revalidatePath("/users");
}

export default async function Users({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const u = await requireAdmin();
  const sp = await searchParams;
  const users = await db.user.findMany({ where: { orgId: u.orgId }, orderBy: { createdAt: "asc" }, include: { _count: { select: { assignedLeads: true } } } });
  return (
    <>
      <h1>Users</h1>
      {sp.error && <div className="alert error">{sp.error}</div>}
      <Card>
        <table><thead><tr><th>User</th><th>Role</th><th>Active</th><th>Round-robin</th><th>Available for live transfer</th><th>Transfer phone</th><th>Sheet tab</th><th>New password</th><th></th></tr></thead><tbody>
          {users.map((x) => (
            <tr key={x.id}>
              <td>{x.name}<div className="small muted">{x.email} · {x._count.assignedLeads} leads</div></td>
              <td colSpan={8}>
                <form action={updateUser} className="inline">
                  <input type="hidden" name="id" value={x.id} />
                  <select name="role" defaultValue={x.role}><option value="RECRUITER">Recruiter</option><option value="ADMIN">Admin</option></select>
                  <input type="checkbox" name="active" defaultChecked={x.active} title="active" />
                  <input type="checkbox" name="rr" defaultChecked={x.inRoundRobin} title="round-robin" />
                  <input type="checkbox" name="avail" defaultChecked={x.availableForTransfer} title="available" />
                  <input name="transferPhone" type="tel" autoComplete="off" defaultValue={x.transferPhoneE164 ?? ""} placeholder="+1…" size={14} />
                  <input name="sheetTab" autoComplete="off" defaultValue={x.sheetTab ?? ""} placeholder="e.g. Dennis" size={10} title="This recruiter's tab in the lead sheet" />
                  <input name="password" type="password" autoComplete="new-password" placeholder="leave blank" size={12} />
                  <button className="secondary">Save</button> {!x.active && <Badge v="INACTIVE" tone="bad" />}
                </form>
                {x.id !== u.id && (
                  <form action={deleteUser} style={{ display: "inline-block", marginLeft: 8 }}>
                    <input type="hidden" name="id" value={x.id} />
                    <ConfirmButton className="danger" danger title={`Delete ${x.name}?`} message={`Their login stops working. Their ${x._count.assignedLeads} leads stay on the site and become unassigned.`} confirmLabel="Delete user">Delete</ConfirmButton>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody></table>
        <p className="small muted">Checkbox order: active · in round-robin · available for live transfer. Sheet tab: when a lead is moved from the Pool to this tab of the lead sheet, it is assigned to this user here too.</p>
      </Card>
      <Card title="Add recruiter or admin login">
        <form action={createUser} className="inline">
          <input name="name" placeholder="Name, e.g. Denis" autoComplete="off" required /><input name="email" type="email" placeholder="Login email, e.g. denis@tbt.local" autoComplete="off" required />
          <input name="password" type="password" placeholder="Temporary password (12+)" autoComplete="new-password" required />
          <input name="sheetTab" placeholder="Sheet tab, e.g. Dennis" autoComplete="off" />
          <select name="role"><option value="RECRUITER">Recruiter</option><option value="ADMIN">Admin</option></select>
          <button>Create</button>
        </form>
      </Card>
    </>
  );
}
