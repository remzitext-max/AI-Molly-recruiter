import { requireUser } from "@/lib/auth";
import { integrationStatuses } from "@/adapters/registry";
import { config } from "@/lib/config";
import { Badge, Card } from "@/components/ui";

export default async function Integrations() {
  await requireUser();
  const list = integrationStatuses();
  return (
    <>
      <h1>Integrations</h1>
      <p className="muted">Mode: <strong>{config.mode.toUpperCase()}</strong>. “Mock” means simulated inside this app; it never reaches a real phone or provider. “Unverified” means implemented from documentation but not yet tested on your account.</p>
      <Card>
        <table>
          <thead><tr><th>Area</th><th>Provider</th><th>State</th><th>Details</th><th>Capabilities</th></tr></thead>
          <tbody>
            {list.map((s, i) => (
              <tr key={i}>
                <td className="small">{s.kind.replace(/_/g, " ")}</td><td>{s.provider}</td>
                <td><Badge v={s.state} />{s.isMock && s.state !== "mock" && <> <Badge v="MOCK" tone="demo" /></>}</td>
                <td className="small">{s.detail}</td>
                <td className="small">{s.capabilities ? Object.entries(s.capabilities).map(([k, v]) => <div key={k}>{k.replace(/_/g, " ")}: <Badge v={v} tone={v === "implemented" ? "ok" : v === "blocked" ? "bad" : v === "mocked" ? "demo" : "warn"} /></div>) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
