import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addLead, resetDb, seedBase } from "./helpers";
import { createOwnDriver, saveUploadedRecording, sttTurns, transcribeUpload, uploadType } from "@/lib/recruiter-upload";
import { canonicalStatus, setRecruiterStatus } from "@/lib/recruiter-status";
import { transferLead } from "@/lib/assignment";
import { loadDriverProfile, saveProfileEdits } from "@/lib/driver-profile";

beforeEach(async () => { await resetDb(); });
afterEach(() => { delete process.env.TELNYX_API_KEY; vi.restoreAllMocks(); });

const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200)]);

describe("recruiter statuses", () => {
  it("reads the sheet's spellings and stops Crystal for worked statuses", async () => {
    expect(canonicalStatus("callback")).toBe("Call back");
    expect(canonicalStatus("our driver - working")).toBe("Our driver – working");
    expect(canonicalStatus("whatever")).toBeNull();
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await setRecruiterStatus(r.leadId, "Need approval", { id: base.molly.id, name: "Molly" });
    const l = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l).toMatchObject({ recruiterStatus: "Need approval", hireStage: "PROCESSING" });
  });
});

describe("transfer and profile edits", () => {
  it("moves a lead to another recruiter and keeps Crystal's answer next to the recruiter's", async () => {
    const base = await seedBase();
    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await db.lead.update({ where: { id: r.leadId }, data: { assignedToId: base.molly.id } });
    expect(await transferLead(r.leadId, base.alex.id, { id: base.molly.id, name: "Molly" })).toEqual({ changed: true, to: "Alex" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: r.leadId } })).assignedToId).toBe(base.alex.id);

    await db.screeningField.create({ data: { leadId: r.leadId, key: "experience_years", reportedValue: "2 years", status: "CAPTURED" } });
    const changed = await saveProfileEdits({ ...base.alex }, r.leadId, { experience_years: "3 years", firstName: "Mark", recent_companies: "Swift, 2023 - now\nWerner, 2021 - 2023" });
    expect(changed).toEqual(["First name", "Experience", "Previous employers"]);
    const f = await db.screeningField.findUniqueOrThrow({ where: { leadId_key: { leadId: r.leadId, key: "experience_years" } } });
    expect(f).toMatchObject({ reportedValue: "2 years", verifiedValue: "3 years" });
    const p = await loadDriverProfile(base.alex, r.leadId);
    expect(p!.name).toBe("Mark Test");
    expect(p!.edit.recent_companies).toBe("Swift, 2023 - now\nWerner, 2021 - 2023");
  });
});

describe("Create form: a recruiter's own driver", () => {
  it("is assigned to the recruiter, never queued for Crystal, and filled from the uploaded recording", async () => {
    const base = await seedBase();
    const r = await createOwnDriver(base.molly, { phone: "(312) 555-0144", firstName: "Tony", drivingType: "team" });
    if (!("leadId" in r) || !r.leadId) throw new Error(JSON.stringify(r));
    const lead = await db.lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(lead).toMatchObject({ ownDriver: true, createdById: base.molly.id, assignedToId: base.molly.id, pipelineStatus: "HANDED_OFF" });
    expect(await db.job.count({ where: { type: "lead.attempt-call" } })).toBe(0);

    expect(uploadType(Buffer.from("not audio"))).toBeNull();
    expect(await saveUploadedRecording(base.molly, r.leadId, { name: "x.txt", data: Buffer.from("not audio") })).toEqual({ error: "Upload an mp3, wav, m4a or ogg recording" });
    const up = await saveUploadedRecording(base.molly, r.leadId, { name: "call.mp3", data: mp3 });
    if (!("attemptId" in up)) throw new Error("not saved");
    expect(await db.job.count({ where: { type: "call.transcribe-upload" } })).toBe(1);

    process.env.TELNYX_API_KEY = "KEY";
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      urls.push(String(u));
      if (String(u).includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "x", duration: 95, words: [
          { punctuated_word: "How", speaker: 0 }, { punctuated_word: "long?", speaker: 0 },
          { punctuated_word: "Five", speaker: 1 }, { punctuated_word: "years.", speaker: 1 },
        ] }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"experience_years":"5 years","call_result":"interested"}' } }] }));
    });
    const out = await transcribeUpload(up.attemptId!);
    expect(out.filled).toEqual(["experience_years"]);
    expect(urls[0]).toContain("/v2/ai/audio/transcriptions");
    const a = await db.callAttempt.findUniqueOrThrow({ where: { id: up.attemptId } });
    expect(a.transcript).toEqual([{ speaker: "speaker_1", text: "How long?" }, { speaker: "speaker_2", text: "Five years." }]);
    expect(a.endedAt!.getTime() - a.startedAt!.getTime()).toBe(95_000);
    const p = await loadDriverProfile(base.molly, r.leadId);
    expect(p!.source).toBe("Recruiter's own driver");
    expect(p!.calls[0].result).toBe("Recording uploaded by Molly");
  });

  it("joins words without speakers into one block", () => {
    expect(sttTurns({ text: " hello  there " })).toEqual([{ speaker: "call", text: "hello there" }]);
    expect(sttTurns({})).toEqual([]);
  });
});
