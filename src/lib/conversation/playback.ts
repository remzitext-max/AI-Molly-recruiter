// Speech playback controller for a live media bridge (our own audio pipeline,
// or a provider's custom-LLM socket). Guarantees:
// - barge-in (driver starts talking) stops current audio immediately;
// - queued speech from older turns is cancelled, never played late;
// - synthesis of cancelled items is aborted via AbortSignal.

export interface AudioSink {
  play(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  stop(): void;
}

export interface Synthesizer {
  /** Yields audio chunks for text; must honour the abort signal. */
  stream(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

interface Item { id: number; turnId: number; text: string; ctrl: AbortController; state: "queued" | "playing" | "done" | "cancelled" }

export interface PlaybackEvent { type: "started" | "finished" | "cancelled" | "first_audio"; itemId: number; turnId: number; atMs: number; latencyMs?: number }

export class SpeechPlayback {
  private items: Item[] = [];
  private seq = 0;
  private running = false;
  private currentTurn = 0;
  readonly events: PlaybackEvent[] = [];

  constructor(private synth: Synthesizer, private sink: AudioSink, private clock: () => number = () => Date.now()) {}

  /** Start a new agent turn: anything still queued from older turns is stale. */
  beginTurn(turnId: number) {
    this.currentTurn = turnId;
    for (const it of this.items) if (it.turnId < turnId && it.state === "queued") this.cancel(it);
  }

  say(text: string, turnId = this.currentTurn) {
    const it: Item = { id: ++this.seq, turnId, text, ctrl: new AbortController(), state: "queued" };
    if (turnId < this.currentTurn) { it.state = "cancelled"; return it.id; }
    this.items.push(it);
    void this.pump();
    return it.id;
  }

  /** Driver interrupted: stop audio now and drop everything pending. */
  bargeIn() {
    this.sink.stop();
    for (const it of this.items) if (it.state === "queued" || it.state === "playing") this.cancel(it);
  }

  get pending() { return this.items.filter((i) => i.state === "queued" || i.state === "playing").map((i) => i.id); }
  state(id: number) { return this.items.find((i) => i.id === id)?.state; }

  private cancel(it: Item) {
    it.state = "cancelled";
    it.ctrl.abort();
    this.events.push({ type: "cancelled", itemId: it.id, turnId: it.turnId, atMs: this.clock() });
  }

  async idle() {
    while (this.running) await new Promise((r) => setTimeout(r, 1));
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const it = this.items.find((i) => i.state === "queued");
        if (!it) break;
        it.state = "playing";
        const t0 = this.clock();
        this.events.push({ type: "started", itemId: it.id, turnId: it.turnId, atMs: t0 });
        let first = true;
        try {
          for await (const chunk of this.synth.stream(it.text, it.ctrl.signal)) {
            if (it.ctrl.signal.aborted) break;
            if (first) { first = false; this.events.push({ type: "first_audio", itemId: it.id, turnId: it.turnId, atMs: this.clock(), latencyMs: this.clock() - t0 }); }
            await this.sink.play(chunk, it.ctrl.signal);
            if (it.ctrl.signal.aborted) break;
          }
        } catch (e) {
          if (!it.ctrl.signal.aborted) throw e;
        }
        if (it.state === "playing") { it.state = "done"; this.events.push({ type: "finished", itemId: it.id, turnId: it.turnId, atMs: this.clock() }); }
      }
    } finally {
      this.running = false;
    }
  }
}

/** Splits text into short sentence chunks so playback can stop between them. */
export function sentenceChunks(text: string): string[] {
  return text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}
