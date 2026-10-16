import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { recordEvent } from "@/lib/activity";
import { Badge, Card } from "@/components/ui";

async function createUser(fd: FormData) {
  "use server";
  const u = await requireAdmin();
  const email = String(fd.get("email") || "").toLowerCase().trim();
  const pw = String(fd.get("password") || "");
  if (!email || pw.length < 12) redirect("/users?error=Email and a password of at least 12 characters are required");
  if (await db.user.findUnique({ where: { email } })) redirect("/users?error=Email already exists");
  await db.user.create({ data: { orgId: u.orgId, email, name: String(fd.get("name") || email), role: fd.get("role") === "ADMIN" ? "ADMIN" : "RECRUITER", passwordHash: await hashPassword(pw) } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "USER_CREATED", message: `User ${email} created` });
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
      transferPhoneE164: phone ? normalizePhone(phone) : null,
    },
  });
  if (!active) await db.session.deleteMany({ where: { userId: id } });
  if (String(fd.get("password") || "").length >= 12) await db.user.update({ where: { id }, data: { passwordHash: await hashPassword(String(fd.get("password"))) } });
  await recordEvent({ actorType: "USER", actorId: u.id, orgId: u.orgId, type: "USER_UPDATED", message: `User ${target.email} updated` });
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
        <table><thead><tr><th>User</th><th>Role</th><th>Active</th><th>Round-robin</th><th>Available for live transfer</th><th>Transfer phone</th><th>New password</th><th></th></tr></thead><tbody>
          {users.map((x) => (
            <tr key={x.id}>
              <td>{x.name}<div className="small muted">{x.email} · {x._count.assignedLeads} candidates</div></td>
              <td colSpan={7}>
                <form action={updateUser} className="inline">
                  <input type="hidden" name="id" value={x.id} />
                  <select name="role" defaultValue={x.role}><option value="RECRUITER">Recruiter</option><option value="ADMIN">Admin</option></select>
                  <input type="checkbox" name="active" defaultChecked={x.active} title="active" />
                  <input type="checkbox" name="rr" defaultChecked={x.inRoundRobin} title="round-robin" />
                  <input type="checkbox" name="avail" defaultChecked={x.availableForTransfer} title="available" />
                  <input name="transferPhone" defaultValue={x.transferPhoneE164 ?? ""} placeholder="+1…" size={14} />
                  <input name="password" type="password" placeholder="leave blank" size={12} />
                  <button className="secondary">Save</button> {!x.active && <Badge v="INACTIVE" tone="bad" />}
                </form>
              </td>
            </tr>
          ))}
        </tbody></table>
        <p className="small muted">Checkbox order: active · in round-robin · available for live transfer.</p>
      </Card>
      <Card title="Add user">
        <form action={createUser} className="inline">
          <input name="name" placeholder="Name" /><input name="email" type="email" placeholder="Email" required />
          <input name="password" type="password" placeholder="Temporary password (12+)" required />
          <select name="role"><option value="RECRUITER">Recruiter</option><option value="ADMIN">Admin</option></select>
          <button>Create</button>
        </form>
      </Card>
    </>
  );
}
