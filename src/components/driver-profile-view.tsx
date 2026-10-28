// The driver's anketa: header, profile and deal, past employers, calls,
// documents and timeline. Pure markup, used by the Leads popup.
import type { DriverProfile, Row } from "@/lib/driver-profile";

const blank = "—";

function Pairs({ rows }: { rows: Row[] }) {
  return (
    <table className="kv pairs"><tbody>
      {rows.map(([k, v]) => <tr key={k}><th>{k}</th><td className={v ? "" : "muted"}>{v || blank}</td></tr>)}
    </tbody></table>
  );
}

export function DriverProfileView({ p }: { p: DriverProfile }) {
  return (
    <div className="dp">
      <div className="dp-head">
        <div className="dp-avatar">{p.initials}</div>
        <div style={{ minWidth: 0 }}>
          <h2 className="dp-name">{p.name}</h2>
          <div className="dp-meta">
            <span>{p.phone}</span>
            {p.email && <span>{p.email}</span>}
            {p.location && <span>{p.location}</span>}
            {p.source && <span>{p.source}</span>}
          </div>
        </div>
      </div>

      <div className="dp-strip">
        <span><b>Status</b> {p.hiring ?? p.status}</span>
        <span><b>Recruiter</b> {p.recruiter}</span>
        <span><b>Applied</b> {p.applied}</span>
        <span className={`badge ${p.fit.tone}`} title={p.fit.text}>Fit {p.fit.text.split(":")[0]}</span>
      </div>

      <h3 className="dp-h">Driver profile and deal</h3>
      <div className="dp-cols">
        <Pairs rows={p.driver} />
        <Pairs rows={p.deal} />
      </div>
      {p.summary && <p className="dp-note">{p.summary}</p>}

      <h3 className="dp-h">Previous employers (last 3 years, from the driver)</h3>
      {p.employers.length ? (
        <table className="dp-table"><tbody>{p.employers.map((e, i) => <tr key={i}><td>{e}</td></tr>)}</tbody></table>
      ) : <p className="muted small">Not collected yet.</p>}

      <h3 className="dp-h">Calls</h3>
      {p.calls.length ? (
        <table className="dp-table">
          <thead><tr><th>When (Central)</th><th>Length</th><th>Result</th><th>Ended by</th><th>Recording</th></tr></thead>
          <tbody>{p.calls.map((c) => (
            <tr key={c.id}><td>{c.when}</td><td>{c.length || blank}</td><td>{c.result}</td><td>{c.endedBy || blank}</td>
              <td>{c.recording ? <audio controls preload="none" src={`/api/recordings/${c.id}`} style={{ height: 30, maxWidth: 220 }} /> : blank}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="muted small">No calls yet.</p>}

      <h3 className="dp-h">Documents</h3>
      {p.documents.length ? (
        <table className="dp-table"><tbody>{p.documents.map((d) => (
          <tr key={d.id}><td><a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">{d.kind}</a></td><td>{d.when}</td><td className="small">{d.read ? `Read by AI: ${d.read}` : ""}</td></tr>
        ))}</tbody></table>
      ) : <p className="muted small">No CDL or medical card yet.</p>}

      <h3 className="dp-h">Timeline</h3>
      <table className="dp-table"><tbody>{p.timeline.map((t, i) => (
        <tr key={i}><td className="nowrap small muted">{t.when}</td><td className="nowrap small">{t.who}</td><td className="small">{t.what}</td></tr>
      ))}</tbody></table>
    </div>
  );
}
