// Creates (or updates) the Retell voice agent from this app's settings.
// Run on the server:
//   docker compose exec web npx tsx scripts/retell-setup.ts [voice_id]
// It only configures the agent. It never buys numbers and never places calls.
import { config } from "../src/lib/config";
import { db } from "../src/lib/db";
import { getSettings } from "../src/lib/settings";
import { AGENT_TOOLS, buildAgentPrompt, toolEndpoint, voicemailText } from "../src/lib/agent-config";

const BASE = "https://api.retellai.com";
const DEFAULT_VOICE = "retell-Cimo"; // Retell platform voice, used until Molly's cloned voice ID is given

async function retell<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.retell.apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Retell ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  if (!config.retell.apiKey) throw new Error("RETELL_API_KEY is empty in .env");
  const voiceArg = process.argv[2];

  const agents = await retell<{ agent_id: string; agent_name?: string }[]>("GET", "/list-agents"); // fails fast on a wrong key
  console.log("Retell API key OK");

  const org = await db.organization.findFirst();
  const company = org?.name ?? process.env.ORG_NAME ?? "our company";
  const s = await getSettings();

  const llmBody = {
    model: "gpt-4.1-mini",
    start_speaker: "agent",
    general_prompt: await buildAgentPrompt(company),
    general_tools: [
      ...AGENT_TOOLS.map((t) => ({
        type: "custom", name: t.name, description: t.description, parameters: t.parameters,
        url: toolEndpoint(), speak_during_execution: false, speak_after_execution: true, timeout_ms: 10_000,
      })),
      {
        type: "transfer_call", name: "transfer_to_manager",
        description: "Transfer the call to the human recruiter (\"my manager\"). Use only after request_human returned transfer \"pending\".",
        transfer_destination: { type: "predefined", number: "{{transfer_number}}" },
        transfer_option: { type: "cold_transfer" },
      },
      { type: "end_call", name: "end_call", description: "End the call after set_call_outcome, or when the driver is done." },
    ],
  };
  const agentBody = {
    agent_name: `${company} - Molly AI recruiter`,
    language: "en-US",
    webhook_url: `${config.appUrl}/api/webhooks/retell`,
    webhook_events: ["call_started", "call_ended", "call_analyzed", "transfer_started", "transfer_bridged", "transfer_cancelled", "transfer_ended"],
    voicemail_option: { action: { type: "static_text", text: voicemailText(s.voicemailMessage, company) } },
    end_call_after_silence_ms: 30_000,
    max_call_duration_ms: 15 * 60_000,
  };

  // Reuse an agent this script made earlier, so a re-run never creates a duplicate.
  const existing = config.retell.agentId ?? agents.find((a) => a.agent_name === agentBody.agent_name)?.agent_id;
  if (existing && !config.retell.agentId) console.log(`Found existing agent. Put this line in .env:\nRETELL_AGENT_ID=${existing}`);
  if (existing) {
    const agent = await retell<{ response_engine: { llm_id?: string }; voice_id: string }>("GET", `/get-agent/${existing}`);
    if (!agent.response_engine.llm_id) throw new Error("Existing agent does not use a Retell LLM; clear RETELL_AGENT_ID to create a new one");
    await retell("PATCH", `/update-retell-llm/${agent.response_engine.llm_id}`, llmBody);
    await retell("PATCH", `/update-agent/${existing}`, { ...agentBody, voice_id: voiceArg ?? agent.voice_id });
    console.log(`Updated agent ${existing} (voice ${voiceArg ?? agent.voice_id}).`);
    return;
  }

  const llm = await retell<{ llm_id: string }>("POST", "/create-retell-llm", llmBody);
  const agent = await retell<{ agent_id: string }>("POST", "/create-agent", {
    ...agentBody, voice_id: voiceArg ?? DEFAULT_VOICE, response_engine: { type: "retell-llm", llm_id: llm.llm_id },
  });
  console.log(`Created agent. Put this line in .env, then restart:\nRETELL_AGENT_ID=${agent.agent_id}`);
  if (!voiceArg) console.log(`Using test voice ${DEFAULT_VOICE}. Re-run with Molly's voice ID to switch.`);
}

let completed = false;
process.on("exit", (code) => console.log(completed ? "Setup finished" : `Setup stopped before finishing (exit code ${code})`));

main()
  .then(() => { completed = true; })
  .catch((e) => { console.error("SETUP FAILED:", e instanceof Error ? e.stack ?? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
