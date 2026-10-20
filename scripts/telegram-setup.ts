// Telegram bot helper.
//   docker compose exec web npx tsx scripts/telegram-setup.ts          -> checks the bot token and lists chats that wrote to the bot (their chat IDs)
//   docker compose exec web npx tsx scripts/telegram-setup.ts test     -> sends a test message to TELEGRAM_CHAT_ID
//   docker compose exec web npx tsx scripts/telegram-setup.ts last     -> sends the card for the most recent answered real call
import { config } from "../src/lib/config";
import { db } from "../src/lib/db";
import { buildCallReport, sendTelegram } from "../src/lib/telegram";

type Update = { message?: { chat: { id: number; type: string; title?: string; first_name?: string; username?: string } } };

async function api<T>(method: string): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`);
  const j = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!j.ok) throw new Error(`Telegram ${method} failed: ${j.description ?? res.status}`);
  return j.result;
}

async function main() {
  if (!config.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  const mode = process.argv[2];

  if (!mode) {
    const me = await api<{ username: string }>("getMe");
    console.log(`Bot token OK: @${me.username}`);
    const updates = await api<Update[]>("getUpdates");
    const chats = new Map<number, string>();
    for (const u of updates) if (u.message) chats.set(u.message.chat.id, `${u.message.chat.type} ${u.message.chat.title ?? u.message.chat.first_name ?? ""} ${u.message.chat.username ? "@" + u.message.chat.username : ""}`.trim());
    if (!chats.size) console.log(`No chats yet. Open Telegram, send any message to @${me.username} (or add it to a group and write there), then run this again.`);
    for (const [id, who] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${who})`);
    return;
  }
  if (!config.telegram.chatId) throw new Error("TELEGRAM_CHAT_ID is not set in .env");
  if (mode === "test") {
    await sendTelegram("✅ Molly AI recruiter is connected. Driver cards will arrive here after each answered call.");
    console.log("Test message sent.");
    return;
  }
  if (mode === "last") {
    const a = await db.callAttempt.findFirst({ where: { startedAt: { not: null }, isDemo: false }, orderBy: { startedAt: "desc" } });
    const text = a && (await buildCallReport(a.id));
    if (!text) throw new Error("No answered real call to report yet");
    await sendTelegram(text);
    console.log(`Card sent for call ${a!.id}.`);
    return;
  }
  throw new Error(`Unknown mode "${mode}". Use no argument, "test" or "last".`);
}

main()
  .catch((e) => { console.error("TELEGRAM SETUP FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
