# What is needed to activate production

## Decisions / information from you
1. **Google Sheet**: "Molly AI - Driver Leads" is already created in your Drive. Still needed: the leads themselves (with consent source and date per driver), and whether the app may write progress into the "AI status" column.
2. **Approved offer facts**: company/agency identity, pay structure and conditions, bonuses and eligibility, home time, equipment, operating areas, deductions/escrow, orientation and travel, screening requirements, FAQs, Molly's contact hours. Enter them on **Offers & knowledge** and publish (unchecked "synthetic").
3. **Contact policy, reviewed by counsel**: where drivers give consent for automated/AI calls and texts (TCPA/FCC rules for AI voice to mobiles), the exact disclosure and recording-notice wording, which states you call, permitted hours, DNC scrubbing. Then **Confirm contact policy** in Controls.
4. **Molly's voice**: her signed consent (scope, date, where stored) and her recording (WAV, quiet room, single speaker; 1–3 min minimum, 30+ min for a professional clone).
5. **Approval of spend**: Retell (≈ $0.11–0.23 per call minute, $2/month per number, optional $0.10/call branded caller ID) and the voice provider plan (Cartesia or ElevenLabs). See INTEGRATIONS.md / VOICE.md.

## Accounts and credentials
- **Retell**: account, agent created from `buildAgentPrompt()` + `AGENT_TOOLS`, phone number(s), business profile for verified/branded caller ID → `RETELL_API_KEY`, `RETELL_AGENT_ID`, `RETELL_FROM_NUMBER`.
- **RingCentral**: product/edition (RingEX or RingCX?), JWT app (`SMS`, `RingOut`, `ReadAccounts`, `ReadCallLog`, `SubscriptionWebhook`), SMS number with Confirmed TCR campaign, webhook subscription → `RINGCENTRAL_*`.
- **Google**: a Cloud project with the Sheets API enabled, a service account and its key, and the sheet shared with that account → `GOOGLE_*` variables (INTEGRATIONS.md).
- **Recruiters**: user accounts, and for live transfer each recruiter's direct number + "available for transfer".
- **HeyGen** (optional, previews only): `HEYGEN_API_KEY`.
- Server, domain and TLS (DEPLOYMENT.md).

## Account-level tests (no real drivers)
1. Retell test calls to team phones: voice quality, measured latency, interruption behaviour, voicemail detection.
2. Warm transfer from Retell to a recruiter's RingCentral number; confirm the app marks it confirmed only after `transfer_bridged`, and that a declined transfer creates a callback task.
3. Webhook signature verification on the first real Retell event.
4. RingCentral SMS to a team phone; reply STOP and confirm suppression.
5. RingOut click-to-call from a candidate page.
6. Caller-ID display on AT&T, Verizon and T-Mobile handsets.
7. Google Sheets: preview your sheet in the app; if write-back is on, confirm the status column updates on a test row.
8. HeyGen: whether the workspace may create clones (403 check) and HeyGen's written answer on phone use (only if you still want HeyGen).

## Switches (enforced in code)
`APP_MODE=live` → credentials present → real offer published → permissions recorded on leads → contact policy confirmed → **Enable production contact**. The global pause and per-campaign pause stop everything immediately.
