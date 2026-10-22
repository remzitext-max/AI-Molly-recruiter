# Integration guide

Research date 2026-10-15. Sources with links: [RESEARCH-2026-10-15.md](RESEARCH-2026-10-15.md). Nothing below was tested against your real accounts: no credentials were supplied, and no real calls or texts may be sent during development.

Legend: **Implemented** = code exists and is covered by tests against mocks. **Unverified** = implemented from official docs, needs an account test. **Mocked** = demo-only simulation. **Blocked** = cannot be done with what is known.

## Summary

| Capability | Path chosen | State |
|---|---|---|
| CSV/XLSX import, manual entry | In-app | Implemented |
| Lead webhook from another system | `POST /api/webhooks/leads` (HMAC `x-molly-signature`) | Implemented |
| Google Sheets lead sync | Sheets API v4 with a service account; rows keyed on your ID column | Implemented (demo sheet); Unverified on your sheet |
| Progress write-back to the sheet | Optional status column, written as plain text (`valueInputOption=RAW`) | Implemented (demo sheet); Unverified on your sheet |
| Outbound AI call + real-time audio | Retell AI (`POST /v2/create-phone-call`) | Unverified |
| AI audio through RingCentral | RingCentral has no public SIP trunk for third-party AI | **Blocked** |
| Voicemail detection | Retell `voicemail_reached` | Unverified |
| Call events | Retell webhooks → `/api/webhooks/retell` (`X-Retell-Signature`) | Unverified |
| Agent tools (answers, screening, opt-out, callback, CDL link, handoff) | Retell custom functions → `/api/agent/tools` | Unverified |
| Live transfer to a recruiter | Retell transfer to the recruiter's RingCentral number (normal phone transfer); success only on `transfer_bridged` | Unverified |
| Caller ID | Retell-purchased or imported number (not a RingCentral number) | Unverified |
| SMS (CDL link) and inbound replies/STOP | RingCentral SMS API + webhook `/api/webhooks/ringcentral` | Unverified; needs TCR 10DLC approval |
| Recruiter click-to-call | RingCentral RingOut | Unverified |
| Inbound calls / driver calling back | Callback number in voicemail/texts rings Molly's RingCentral line (human). AI inbound not built | Not built |
| Document storage | Private local disk (encrypted volume recommended) | Implemented |
| Document extraction (OCR) | None configured; mock shows "uncertain" fields | Mocked |
| MVR, PSP/PEV, Clearinghouse | Not integrated; never claimed | Not built |

## RingCentral: what works and what does not

- **RingOut and Call Control are signalling only.** They start, transfer or end calls but give the app no audio, so they cannot carry an AI conversation.
- **Two-way audio on RingEX** is only possible by registering as a phone (softphone/WebRTC SDK or manual SIP credentials) and building our own media bridge. That is fragile and not recommended for v1.
- **No SIP trunk for Retell.** RingCentral staff confirmed in March 2026 that there is no open/public SIP trunking; BYOC is for bringing a carrier into RingCentral, not for AI platforms.
- **RingCX (contact-center product)** has one-way audio streaming and a SIP bot integration. If your account is RingCX, ask your RingCentral rep whether its IVA/SIP bot routing can point to Retell.

**Recommended:** AI calls go out from Retell numbers (verified + branded caller ID), transfers go to Molly's RingCentral direct number, and RingCentral is used for SMS, RingOut and call logs.

### RingCentral setup (when ready)
1. Developer Console app with **JWT** auth. Scopes: `SMS`, `RingOut`, `ReadAccounts`, `ReadCallLog`, `SubscriptionWebhook` (`CallControl` only if needed; it requires review).
2. Env: `RINGCENTRAL_CLIENT_ID`, `RINGCENTRAL_CLIENT_SECRET`, `RINGCENTRAL_JWT`, `RINGCENTRAL_SMS_FROM`.
3. Optional per-recruiter lines: `RINGCENTRAL_TAB_SENDERS=<sheet tab gid>=<their RC number>` plus `RINGCENTRAL_JWT_<gid>` (that recruiter creates a JWT credential in the RingCentral developer console for the same app). Texts to leads from that tab (CDL request, missed-call text) go from their number, and replies to it are read every minute.
3. SMS number must be linked to a **Confirmed TCR brand and campaign**.
4. Webhook subscription with event filter `/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS`, address `https://<your-domain>/api/webhooks/ringcentral`, and a `verificationToken` equal to `RINGCENTRAL_WEBHOOK_VERIFICATION_TOKEN`. The endpoint echoes `Validation-Token` on creation. Confirm during the account test that deliveries carry the `Verification-Token` header (the research marked the per-delivery header as unconfirmed).

## Retell setup (when approved)
1. Create the Retell agent: `docker compose exec web npx tsx scripts/retell-setup.ts [voice_id]` builds the Retell LLM (prompt from `buildAgentPrompt()`, the `AGENT_TOOLS` custom functions, a `transfer_to_manager` tool using `{{transfer_number}}`, and `end_call`) plus the agent with webhook and voicemail settings, and prints `RETELL_AGENT_ID`. Re-running it with `RETELL_AGENT_ID` set updates the same agent. It never buys numbers or places calls.
2. Add a post-call analysis field `outcome` (one of the CallOutcome values) so `call_analyzed` carries it.
3. Enable voicemail detection (static message = the voicemail text in Controls), `honor_internal_dnc`, and transfer (warm) to recruiters.
4. Webhook URL `https://<your-domain>/api/webhooks/retell`; enable `transfer_*` events in addition to the defaults.
5. Env: `RETELL_API_KEY` (the key with the webhook badge), `RETELL_AGENT_ID`, `RETELL_FROM_NUMBER`.
6. Signature check: implemented as documented (HMAC-SHA256 of raw body + timestamp, 5-minute window). Confirm it matches Retell's SDK `verify()` on the first real webhook; if not, switch to the SDK.

Estimated per-minute cost from Retell's published prices: infrastructure $0.055 + voice $0.015 (Cartesia) or $0.04–0.10 (ElevenLabs) + LLM about $0.02–0.06 + telephony $0.015 ≈ **$0.11–0.23/min**, plus $2/month per number and $0.10 per call for branded caller ID. Nothing has been purchased.

## Google Sheets (the "Google board")
Confirmed by the owner on 2026-10-15 that leads arrive in a Google Sheet.

**How it works**
1. An admin opens **Import leads → Google Sheets sync**, picks a campaign and clicks **Read sheet and preview**. This uses the normal import preview: column mapping, validation, duplicate and opt-out checks. Nothing is saved until they confirm.
2. Confirming imports the rows and saves the mapping. The admin can then turn on **automatic sync** (every 1–60 minutes, default 5). The worker reads the sheet and imports only rows whose ID it has not seen.
3. Rows are identified by the **ID column** (`GOOGLE_SHEETS_ID_COLUMN`) when it has a value, otherwise by the normalized phone number, never by row number, so sorting, inserting or deleting rows never causes a second call. The ID is optional: you can just paste leads. A phone number already in the system is merged, not called again; opted-out numbers stay suppressed.
4. Edits to rows already imported are not copied over (change those candidates in the app). The connector never deletes or reorders anything in the sheet.
5. Optional write-back: set `GOOGLE_SHEETS_STATUS_COLUMN` to a column header and the app writes the candidate's progress there ("Queued for AI call", "CDL received", "With recruiter (not hired)", "Opted out - do not contact"...). It writes only that one cell per row, as plain text. Leave it unset for read-only access.
6. Values are read as displayed (`valueRenderOption=FORMATTED_VALUE`). Formula results arrive as plain text; the app never runs formulas.

**Setup (needs someone with access to your Google account)**
1. In Google Cloud Console: create a project, enable the **Google Sheets API**, create a **service account**, and create a JSON key for it.
2. Share the sheet with the service account's email: **Viewer** for read-only, **Editor** if you want status write-back. (Some Google Workspace admins block sharing with outside accounts; if so, the admin must allow it.)
3. Set in `.env`: `GOOGLE_SHEETS_SPREADSHEET_ID` (the long ID in the sheet URL between `/d/` and `/edit`), `GOOGLE_SHEETS_RANGE` (default `A:Z` = the first tab; or a tab name such as `Leads`; or `gid:<number>` from the tab URL, which also works for tab names with emoji), `GOOGLE_SHEETS_ID_COLUMN` (header of the ID column, e.g. `Lead ID`), optional `GOOGLE_SHEETS_STATUS_COLUMN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (the `private_key` from the JSON key, with `\n` for line breaks).
4. A ready sheet, **"Molly AI - Driver Leads"**, was created in the owner's Google Drive on 2026-10-15 with these headers (they map automatically): Lead ID, First Name, Last Name, Phone, State, ZIP, Email, Call consent source, Call consent date, SMS consent source, SMS consent date, AI status, Notes. Use `GOOGLE_SHEETS_ID_COLUMN=Lead ID` and `GOOGLE_SHEETS_STATUS_COLUMN=AI status`. Ideally each row also records each driver's contact permission source and date; otherwise leads wait in "needs permission".

**Endpoints used** (from Google's documentation): token `POST https://oauth2.googleapis.com/token` (JWT bearer grant, RS256, 1-hour assertion); read `GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}`; write `PUT .../values/{cell}?valueInputOption=RAW`. Scope `spreadsheets.readonly`, or `spreadsheets` when write-back is on. Google Sheets API use is free within Google's quotas.

**Not yet verified:** reading your actual sheet (no credentials supplied). Tested here against a local demo sheet and with a simulated Google API.


## Telnyx AI Assistant (alternative voice agent)

Use this when Retell outbound calling is not available. Set `VOICE_PROVIDER=telnyx`.

1. In the Telnyx portal create an API key and put it in `TELNYX_API_KEY`. Put the Telnyx number in `TELNYX_FROM_NUMBER` and a long random string in `TELNYX_WEBHOOK_TOKEN`.
2. Run `docker compose exec web npx tsx scripts/telnyx-setup.ts`. It creates the assistant with the same prompt and tools as the Retell agent (webhook tools call `/api/agent/telnyx-tools`, plus transfer to the available recruiter and hangup) and prints `TELNYX_ASSISTANT_ID` and `TELNYX_TEXML_APP_ID`.
3. In the portal, give the assistant's TeXML application the outbound voice profile, then restart the app.

Calls are placed with `POST /v2/texml/ai_calls/{TELNYX_TEXML_APP_ID}`. Status callbacks and the conversation-ended callback go to `/api/webhooks/telnyx` with the token in the URL. Transfers are not confirmed by an event, so a transfer always ends with the callback task from the transfer timeout unless the recruiter updates it.

## Telegram driver cards (optional)

After each answered, non-demo AI call the worker posts the owner's driver card (recruiter, driver type, name, state, home time, experience, pay left blank, can drive (miles the driver says), English rated by the agent, ready date, phone) to one Telegram chat or group. Off unless both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set.

1. In Telegram, talk to @BotFather, `/newbot`, copy the token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Send any message to the new bot (or add it to a group and write there).
3. `docker compose exec web npx tsx scripts/telegram-setup.ts` prints `TELEGRAM_CHAT_ID=...`; add it to `.env` and `docker compose up -d`.
Each CDL / medical card file a driver uploads is also sent to the same group as a document with the driver's name and phone.

4. `scripts/telegram-setup.ts test` sends a test message; `scripts/telegram-setup.ts last` sends the card for the latest answered call.
