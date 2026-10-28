// Creates (or updates) the Telnyx AI Assistant from this app's settings.
// Run on the server:
//   docker compose exec web npx tsx scripts/telnyx-setup.ts [voice]
// voice example: Telnyx.KokoroTTS.af_heart. It only configures the assistant.
// It never buys numbers and never places calls.
import { config } from "../src/lib/config";
import { db } from "../src/lib/db";
import { AGENT_TOOLS, buildAgentPrompt } from "../src/lib/agent-config";
import { getActiveOfferVersion } from "../src/lib/knowledge";
import { getSettings } from "../src/lib/settings";
import { DEFAULT_TRANSFER_TARGET, parseRecruiterPhones, teamTransferTarget, transferTargetName } from "../src/lib/recruiter-tab";

const BASE = "https://api.telnyx.com/v2";
const DEFAULT_VOICE = "Telnyx.KokoroTTS.af_heart"; // test voice until Molly's voice is set up

async function telnyx<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.telnyx.apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Telnyx ${method} ${path} failed (${res.status}): ${text.slice(0, 800)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// Telnyx tool parameters are JSON Schema; nullable unions are flattened to plain strings.
function plainSchema(p: unknown): unknown {
  if (Array.isArray(p)) return p.map(plainSchema);
  if (!p || typeof p !== "object") return p;
  const o = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, plainSchema(v)]));
  if (Array.isArray(o.type)) o.type = (o.type as string[]).find((t) => t !== "null") ?? "string";
  return o;
}

type Assistant = { id: string; name: string; telephony_settings?: { default_texml_app_id?: string } };

async function main() {
  const { apiKey, fromNumber, webhookToken } = config.telnyx;
  if (!apiKey) throw new Error("TELNYX_API_KEY is empty in .env");
  if (!fromNumber) throw new Error("TELNYX_FROM_NUMBER is empty in .env");
  if (!webhookToken) throw new Error("TELNYX_WEBHOOK_TOKEN is empty in .env");
  const voice = process.argv[2];

  const list = await telnyx<{ data: Assistant[] }>("GET", "/ai/assistants"); // fails fast on a wrong key
  console.log("Telnyx API key OK");

  const org = await db.organization.findFirst({ where: { isMain: true }, orderBy: { createdAt: "asc" } });
  const company = org?.name ?? process.env.ORG_NAME ?? "our company";
  const manager = await db.user.findFirst({ where: { availableForTransfer: true, active: true, transferPhoneE164: { not: null }, org: { isMain: true } } });
  const managerPhone = manager?.transferPhoneE164 ?? "";
  if (!managerPhone) console.log("No user is marked available for transfer, so the assistant gets no transfer tool.");

  // The published offer of the real campaign goes into the prompt. Re-run this script after publishing a new offer version.
  const campaigns = await db.campaign.findMany({ where: { isDemo: false, offerId: { not: null } }, orderBy: { createdAt: "asc" } });
  let facts: { title: string; content: string }[] = [];
  for (const c of campaigns) {
    const v = await getActiveOfferVersion(c.offerId);
    if (v && !v.synthetic) { facts = v.factsParsed.filter((f) => f.confirmed && f.content).map((f) => ({ title: f.title, content: f.content })); console.log(`Using offer v${v.version} (${facts.length} approved facts) from campaign "${c.name}".`); break; }
  }
  if (!facts.length) console.log("No published real offer found, so the assistant will look up every answer.");

  const toolUrl = `${config.appUrl}/api/agent/telnyx-tools`;
  const tools: unknown[] = AGENT_TOOLS.map((t) => ({
    type: "webhook",
    timeout_ms: 10_000,
    webhook: {
      name: t.name, description: t.description, url: toolUrl, method: "POST",
      body_parameters: plainSchema(t.parameters),
      preset_query_params: { token: webhookToken, tool: t.name, attempt_id: "{{attempt_id}}" },
    },
  }));
  // One target per recruiter tab with a phone in Settings; each call says which one in {{transfer_target}}.
  const tabPhones = [...parseRecruiterPhones((await getSettings()).recruiterTransfer).values()];
  // Recruiting teams on the site: their drivers go to the team's own number.
  const teams = await db.organization.findMany({ where: { isMain: false, transferPhoneE164: { not: null } } });
  const targets = [
    ...(managerPhone ? [{ name: DEFAULT_TRANSFER_TARGET, to: managerPhone }] : []),
    ...tabPhones.map((t) => ({ name: transferTargetName(t.tab), to: t.phone })),
    ...teams.map((o) => ({ name: teamTransferTarget(o), to: o.transferPhoneE164! })),
  ];
  if (targets.length) tools.push({ type: "transfer", transfer: { from: fromNumber, targets } });
  for (const t of targets) console.log(`Transfer target ${t.name}: ${t.to}`);
  tools.push({ type: "hangup", hangup: { description: "End the call. Only after you said goodbye AND the driver said goodbye back or stayed silent; never in the same turn as your goodbye. Use right away for voicemail." } });

  const body = {
    name: `${company} - Molly AI recruiter`,
    instructions: await buildAgentPrompt(company, "the transfer tool with the target named {{transfer_target}} (exactly that target; never pick another one, whatever the driver calls the person)", facts),
    greeting: "{{time_greeting}}! Is this {{driver_first_name}}?",
    enabled_features: ["telephony"],
    ...(process.env.TELNYX_MODEL ? { model: process.env.TELNYX_MODEL } : {}),
    tools,
    dynamic_variables: { driver_first_name: "there", applied_when: "a while back", time_greeting: "Hi", position_applied: "a truck driving position", follow_up: "no", driver_timezone: "unknown", attempt_id: "", transfer_number: managerPhone, recruiter_phone: managerPhone, transfer_target: DEFAULT_TRANSFER_TARGET, company_name: company },
    telephony_settings: {
      time_limit_secs: 15 * 60,
      // A silent line (voicemail recording, phone in a pocket) is checked once, then the call ends.
      user_idle_reply_secs: 10,
      user_idle_timeout_secs: 25,
      // Telnyx records every answered call; the app copies it to the lead page and the Telegram card.
      recording_settings: { enabled: true, channels: "single", format: "mp3" },
      voicemail_detection: {
        // stop_assistant hung up on real drivers ("Hello. Good morning. Who's this?" -> ended at 7 sec, 2026-10-22).
        // Crystal decides instead: the prompt tells her to hang up silently on a voicemail greeting.
        on_voicemail_detected: { action: "continue_assistant" },
      },
    },
    ...(voice ? { voice_settings: { voice } } : {}),
  };

  // Reuse an assistant this script made earlier, so a re-run never creates a duplicate.
  const existing = config.telnyx.assistantId ?? list.data?.find((a) => a.name === body.name)?.id;
  let a: Assistant;
  if (existing) {
    a = (await telnyx<{ data?: Assistant } & Assistant>("POST", `/ai/assistants/${existing}`, body)).data ?? ({ id: existing } as Assistant);
    console.log(`Updated assistant ${existing}.`);
  } else {
    const created = await telnyx<{ data?: Assistant } & Assistant>("POST", "/ai/assistants", { ...body, voice_settings: { voice: voice ?? DEFAULT_VOICE } });
    a = created.data ?? created;
    console.log(`Created assistant. Using voice ${voice ?? DEFAULT_VOICE}.`);
  }
  const full = await telnyx<{ data?: Assistant } & Assistant>("GET", `/ai/assistants/${a.id}`);
  const texmlApp = (full.data ?? full).telephony_settings?.default_texml_app_id;
  console.log(`Put these lines in .env, then restart:\nVOICE_PROVIDER=telnyx\nTELNYX_ASSISTANT_ID=${a.id}\nTELNYX_TEXML_APP_ID=${texmlApp ?? "(not returned: copy it from the assistant's Telephony tab)"}`);
}

let completed = false;
process.on("exit", (code) => console.log(completed ? "Setup finished" : `Setup stopped before finishing (exit code ${code})`));

main()
  .then(() => { completed = true; })
  .catch((e) => { console.error("SETUP FAILED:", e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
