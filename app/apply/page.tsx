import { ApplyForm } from "./apply-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apply: CDL-A driver jobs | TBT Express", robots: { index: false, follow: false } };

export default async function Apply({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const src = q.src === "tiktok" ? "tiktok" : "youtube";
  return (
    <div style={{ maxWidth: 480, margin: "4vh auto", padding: 16 }}>
      <div className="card">
        <h1 style={{ marginBottom: 4 }}>CDL-A drivers wanted</h1>
        <p className="small muted" style={{ marginTop: 0 }}>TBT Express · Dry van OTR</p>
        <ul style={{ paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Solo: up to 85¢/mile, $3,000 sign-on bonus</li>
          <li>Team: up to $1.10/mile, $20,000 sign-on bonus</li>
          <li>About 3,500 miles a week · Home time 3/3, 4/4 or 5/6</li>
          <li>No West Coast, no NYC</li>
        </ul>
        <ApplyForm src={src} campaign={q.utm_campaign ?? ""} ad={q.utm_content ?? ""} />
      </div>
    </div>
  );
}
