import { redirect } from "next/navigation";
import { createSession, currentUser, verifyLogin } from "@/lib/auth";
import { recordEvent } from "@/lib/activity";
import { config } from "@/lib/config";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await verifyLogin(email, password);
  if (!user) {
    await new Promise((r) => setTimeout(r, 400));
    redirect("/login?error=1");
  }
  await createSession(user.id);
  await recordEvent({ actorType: "USER", actorId: user.id, orgId: user.orgId, type: "LOGIN", message: `${user.email} signed in` });
  redirect("/dashboard");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentUser()) redirect("/dashboard");
  const sp = await searchParams;
  return (
    <div style={{ maxWidth: 380, margin: "10vh auto", padding: 16 }}>
      <div className="card">
        <h1>Molly Recruiting Assistant</h1>
        {config.mode === "demo" && <div className="banner demo">DEMO MODE: synthetic data, simulated calls</div>}
        {sp.error && <div className="alert error">Email or password is incorrect.</div>}
        <form action={login}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="username" style={{ width: "100%" }} />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required autoComplete="current-password" style={{ width: "100%" }} />
          <div style={{ marginTop: 14 }}><button type="submit">Sign in</button></div>
        </form>
      </div>
    </div>
  );
}
