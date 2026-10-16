# Molly's cloned voice: status

**No voice has been cloned.** Molly's recording has not been supplied, no HeyGen integration or API key was available in this workspace, and nothing was purchased.

## Can HeyGen do this?
| Requirement | Finding |
|---|---|
| Voice cloning | Yes (Instant: first 3 min of one recording; Professional: 20+ min, paid slot). API cloning needs workspace permission (else 403). |
| Standalone TTS by API | Yes: `POST /v3/models/audio/tts`, streaming via `POST /v3/models/audio/tts/stream` (SSE). |
| Phone-call suitability | Poor: 44.1 kHz WAV only, 30 requests/min per member, no published latency. |
| Use in a phone voice-agent (Retell) | **No.** HeyGen voices stay in the HeyGen workspace; no export is documented; Retell does not accept HeyGen voices or external TTS streams. |
| Speaker verification | Not documented for voices. |
| Terms for phone use | Not found; ask HeyGen in writing. |

**Blocker:** a HeyGen voice ID cannot drive live phone audio through any documented provider. The app supports HeyGen only for **private previews** (`HEYGEN_API_KEY`, provider "HeyGen" on the Voice page).

## Documented alternative
Clone Molly inside **Retell** using **Cartesia** (instant clone from 10–60 s; $0.015/min on Retell) or **ElevenLabs** ($0.04–0.10/min on Retell). For ElevenLabs, Molly must complete ElevenLabs' own voice verification on her account; private ElevenLabs voices cannot be imported into Retell, so cloning happens through Retell's clone API. Optional: the same ElevenLabs voice can also be connected to HeyGen for videos.

Prices to approve before anything is bought (published, 2026-10-15): Retell pay-as-you-go per minute (see INTEGRATIONS.md); Cartesia Pro $5/mo or Startup $49/mo for professional clones; ElevenLabs Starter $6/mo (instant) or Creator $22/mo (professional). Retell voice cloning itself has no separate listed fee.

## Steps once approved
1. Owner records Molly's written consent (scope, date, where documented) on the **Voice** page. The app stores only what the owner enters; it never fabricates consent evidence.
2. Inspect the recording on the Voice page (local check of sample rate, length, loudness, clipping, silence). Use only Molly's voice: never driver calls or other speakers.
3. Molly completes any provider verification herself.
4. Create a private voice named **"Molly Recruiting Assistant"**; paste the returned provider and voice ID on the Voice page.
5. Generate the private previews (introduction, pay, home time, CDL request, human handoff, pronunciation check), then place test calls to team phones and measure real latency.
6. If the provider fails during a call, the agent must not silently switch to another voice: configure Retell with no fallback voice, and treat failures as technical handoffs.

## Naturalness controls already built
- Short replies, one question at a time, rotating acknowledgements, no re-asking known answers.
- `SpeechPlayback` (`src/lib/conversation/playback.ts`) stops audio on barge-in and cancels stale queued speech (tested). Retell handles this on its side with `interruption_sensitivity`; set it high.
- Decision latency is measured per turn (simulated calls show it in Metrics). End-to-end speech latency must be measured on real test calls; no performance claims are made.

## Consent record (2026-10-15)
Remzi supplied a Telegram screenshot of Molly agreeing to an "AI Molly" making cold calls with her voice (project file `consent/molly-voice-consent-telegram.png`; details in `consent/README.md`). The date of her reply is not visible and is not recorded. The provider's own voice verification must still be done by Molly. Use only Molly-only recordings; call recordings that include drivers must not be uploaded.
