import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { answerQuestion } from "@/lib/knowledge";
import { SYNTHETIC_FACTS } from "@/lib/demo-data";
import { extractSlots, parseCallbackTime } from "@/lib/conversation/nlu";
import { RecruitingBrain } from "@/lib/conversation/brain";
import { resolveTimezone, isWithinWindow, parseWindow } from "@/lib/timezone";
import { normalizePhone } from "@/lib/phone";
import { redactText } from "@/lib/redact";
import { parseLeadFile, guessMapping, createImportPreview, previewBatch, commitBatch } from "@/lib/import";
import { verifyRetellSignature } from "@/adapters/live/retell";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { appliedWhen } from "@/lib/calls";
import { mapTelnyxCallback, parseTelnyxBody } from "@/lib/telnyx-mapping";
import { resetDb, seedBase } from "./helpers";

describe("knowledge answers", () => {
  it("answers approved topics verbatim", () => {
    const r = answerQuestion("How much does the job pay?", SYNTHETIC_FACTS);
    expect(r.kind).toBe("answer");
    if (r.kind === "answer") expect(r.facts[0].key).toBe("pay.cpm");
  });
  it("defers unconfirmed, unknown and conflicting facts", () => {
    expect(answerQuestion("Is there a sign on bonus?", SYNTHETIC_FACTS).kind).toBe("missing");
    expect(answerQuestion("Can I bring my dog?", SYNTHETIC_FACTS).kind).not.toBe("answer");
    expect(answerQuestion("What's the weather in Denver?", SYNTHETIC_FACTS).kind).toBe("unknown_topic");
    const conflicting = [...SYNTHETIC_FACTS, { ...SYNTHETIC_FACTS[1], key: "pay.cpm2", content: "Pay is 70 cents per mile." }];
    expect(answerQuestion("What is the pay per mile?", conflicting).kind).toBe("contradictory");
  });
});

describe("conversation understanding", () => {
  it("extracts several facts from one answer", () => {
    const keys = extractSlots("I've had my class A for 6 years, mostly OTR pulling reefer, I'm in Texas", "cdl_class").map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(["cdl_class", "experience_years", "route_preference", "equipment_experience", "home_location"]));
  });
  it("parses callback times in driver-local time", () => {
    const now = new Date("2026-10-15T15:00:00Z"); // Thu 10:00 Central
    const at = parseCallbackTime("tomorrow at 3pm", now, "America/Chicago")!;
    expect(at.toISOString()).toBe("2026-10-16T20:00:00.000Z");
    expect(parseCallbackTime("whenever", now, "America/Chicago")).toBeNull();
  });
  it("handles corrections, silence and does not re-ask", () => {
    const b = new RecruitingBrain({ companyName: "Demo", recruiterName: "Molly", facts: SYNTHETIC_FACTS, disclosure: "Hi, this is the AI assistant.", voicemailMessage: "vm", uploadLinkTtlMinutes: 60 });
    b.start();
    let t = b.handle({ type: "speech", text: "Sure, I have a class A and 4 years driving" });
    expect(t.say).toMatch(/equipment/);
    t = b.handle({ type: "speech", text: "Actually it's 5 years. Dry van mostly." });
    expect(t.actions.find((a) => a.type === "record_slot" && a.key === "experience_years")).toMatchObject({ status: "CORRECTED", value: "5 years" });
    expect(b.handle({ type: "silence" }).say).toMatch(/still there/);
    const end = b.handle({ type: "silence" });
    expect(end.end).toBe(true);
  });
  it("never asks for SSN, payment or medical details", () => {
    const b = new RecruitingBrain({ companyName: "Demo", recruiterName: "Molly", facts: SYNTHETIC_FACTS, disclosure: "Hi, this is the AI assistant.", voicemailMessage: "vm", uploadLinkTtlMinutes: 60 });
    const said: string[] = [b.start().say];
    const answers = ["yes", "class A", "3 years", "flatbed", "none", "none", "Ohio 43215", "local", "solo", "home daily", "next week", "yes", "yes", "no"];
    for (const a of answers) said.push(b.handle({ type: "speech", text: a }).say);
    expect(said.join(" ")).not.toMatch(/social security|ssn|bank|card number|medical (history|condition)/i);
    const w = new RecruitingBrain({ companyName: "Demo", recruiterName: "Molly", facts: SYNTHETIC_FACTS, disclosure: "Hi", voicemailMessage: "vm", uploadLinkTtlMinutes: 60 });
    w.start();
    expect(w.handle({ type: "speech", text: "sure my social is 123-45-6789" }).actions.some((a) => a.type === "sensitive_data_warning")).toBe(true);
  });
});

describe("utilities", () => {
  it("normalizes phones and timezones", () => {
    expect(normalizePhone("(214) 555-0101")).toBe("+12145550101");
    expect(normalizePhone("123")).toBeNull();
    expect(resolveTimezone("TX", "79901").timezone).toBe("America/Denver");
    expect(resolveTimezone("TX", "75201").timezone).toBe("America/Chicago");
    expect(resolveTimezone("TX", null).ambiguous).toBe(true);
    expect(resolveTimezone("GA", null).timezone).toBe("America/New_York");
    const w = parseWindow("09:00", "19:00", "1,2,3,4,5");
    expect(isWithinWindow(new Date("2026-10-15T15:00:00Z"), "America/Chicago", w)).toBe(true);
    expect(isWithinWindow(new Date("2026-10-15T03:00:00Z"), "America/Chicago", w)).toBe(false);
    expect(isWithinWindow(new Date("2026-10-18T16:00:00Z"), "America/Chicago", w)).toBe(false); // Sunday
  });
  it("redacts license numbers and SSNs", () => {
    expect(redactText("my CDL number is D1234567 and SSN 123-45-6789")).not.toMatch(/D1234567|123-45-6789/);
  });
  it("verifies Retell-style signatures and rejects stale ones", () => {
    const body = '{"event":"call_ended"}';
    const ts = Date.now();
    const sig = `v=${ts},d=${crypto.createHmac("sha256", "key").update(body + ts).digest("hex")}`;
    expect(verifyRetellSignature(body, sig, "key")).toBe(true);
    expect(verifyRetellSignature(body + " ", sig, "key")).toBe(false);
    expect(verifyRetellSignature(body, sig, "key", ts + 10 * 60_000)).toBe(false);
  });
});

describe("CSV/XLSX import", () => {
  beforeEach(async () => { await resetDb(); });

  it("previews, validates and commits a CSV without duplicates", async () => {
    const base = await seedBase();
    const csv = "Lead ID,First Name,Last Name,Phone,State,ZIP,Call Consent Source,Call Consent Date\nA1,Ann,Demo,(214) 555-0131,TX,75201,Web form,2026-10-01\nA2,Bo,Demo,bad-phone,TX,75201,,\nA3,Cy,Demo,214-555-0131,TX,75201,,\n";
    const batch = await createImportPreview({ fileName: "leads.csv", data: Buffer.from(csv), campaignId: base.campaign.id, userId: base.admin.id, orgId: base.org.id, isDemo: true });
    const { preview } = await previewBatch(batch.id, base.org.id);
    expect(preview.map((p) => p.disposition)).toEqual(["new", "error", "duplicate_in_file"]);
    expect(preview[1].errors[0]).toMatch(/Invalid phone/);
    const counts = await commitBatch(batch.id, { id: base.admin.id, orgId: base.org.id });
    expect(counts.created).toBe(1);
    await expect(commitBatch(batch.id, { id: base.admin.id, orgId: base.org.id })).rejects.toThrow();
    // Same file again: rows become duplicate_source, nothing new created
    const b2 = await createImportPreview({ fileName: "leads.csv", data: Buffer.from(csv), campaignId: base.campaign.id, userId: base.admin.id, orgId: base.org.id, isDemo: true });
    const p2 = await previewBatch(b2.id, base.org.id);
    expect(p2.warnings.join(" ")).toMatch(/already imported/);
    expect(p2.preview[0].disposition).toBe("duplicate_source");
    await commitBatch(b2.id, { id: base.admin.id, orgId: base.org.id });
    expect(await db.lead.count()).toBe(1);
    const perm = await db.contactPermission.findFirstOrThrow();
    expect(perm.source).toBe("Web form");
  });

  it("reads XLSX formulas as data and never evaluates them", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Leads");
    ws.addRow(["Name", "Phone", "State"]);
    ws.addRow(["Dee Demo", "(214) 555-0141", "TX"]);
    ws.getCell("A3").value = { formula: 'HYPERLINK("http://evil.example","x")', result: "=cmd|' /C calc'!A0" } as ExcelJS.CellFormulaValue;
    ws.getCell("B3").value = "(214) 555-0142";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheet = await parseLeadFile("leads.xlsx", buf);
    expect(sheet.warnings.join(" ")).toMatch(/Formula cells were not evaluated/);
    expect(sheet.rows[1][0]).toBe("=cmd|' /C calc'!A0"); // kept as inert text
    expect(guessMapping(sheet.headers)).toMatchObject({ fullName: "Name", phone: "Phone", state: "State" });
    await expect(parseLeadFile("leads.xlsm", buf)).rejects.toThrow(/Only .csv and .xlsx/);
  });
});

describe("redaction does not over-match", () => {
  it("keeps ordinary CDL wording", () => {
    expect(redactText("Secure CDL upload link sent; cdl class: Class A")).toBe("Secure CDL upload link sent; cdl class: Class A");
    expect(redactText("my cdl is D1234567")).not.toContain("D1234567");
    expect(redactText("License # 12-345-678")).not.toContain("345");
  });
});

describe("call opening rules", () => {
  it("allows an opening without the word AI but requires the company and no human claim", async () => {
    const { validateOpening } = await import("@/lib/settings");
    expect(validateOpening("Hi, this is Molly's assistant at {company}, calling about the driving job you applied for.")).toBeNull();
    expect(validateOpening("Hi, this is Molly.")).toMatch(/company/);
    expect(validateOpening("Hi, I'm a real person from {company}.")).toMatch(/person/);
    expect(validateOpening("This is {company}, I'm not a robot.")).toMatch(/person/);
  });
  it("still answers truthfully when asked if it is an AI", () => {
    const b = new RecruitingBrain({ companyName: "Demo", recruiterName: "Molly", facts: SYNTHETIC_FACTS, disclosure: "Hi, this is Molly's assistant at Demo.", voicemailMessage: "vm", uploadLinkTtlMinutes: 60 });
    expect(b.start().say).not.toMatch(/\bAI\b/);
    expect(b.handle({ type: "speech", text: "wait, are you a robot?" }).say).toMatch(/I'm an AI assistant/);
  });
});

describe("running without CDL texts", () => {
  it("does not offer a text when CDL texting is off", () => {
    const b = new RecruitingBrain({ companyName: "Demo", recruiterName: "Molly", facts: SYNTHETIC_FACTS, disclosure: "Hi, this is Molly's assistant at Demo.", voicemailMessage: "vm", uploadLinkTtlMinutes: 60, cdlBySms: false });
    const said: string[] = [b.start().say];
    const all: string[] = [];
    for (const a of ["yes", "class A", "3 years", "dry van", "none", "none", "Texas 75201", "OTR", "solo", "every two weeks", "next week", "yes", "yes, sounds good", "no that's all"]) {
      const t = b.handle({ type: "speech", text: a });
      said.push(t.say); all.push(...t.actions.map((x) => x.type));
      if (t.end) break;
    }
    expect(said.join(" ")).toMatch(/get a copy of your CDL/);
    expect(said.join(" ")).not.toMatch(/upload link/i);
    expect(all).not.toContain("send_cdl_link");
  });
});

describe("appliedWhen", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  it("rounds the real application date and never invents one", () => {
    expect(appliedWhen(null, now)).toBe("a while back");
    expect(appliedWhen(ago(10), now)).toBe("about a week ago");
    expect(appliedWhen(ago(21), now)).toBe("about 3 weeks ago");
    expect(appliedWhen(ago(30), now)).toBe("about a month ago");
    expect(appliedWhen(ago(70), now)).toBe("about 2 months ago");
    expect(appliedWhen(ago(400), now)).toBe("over a year ago");
  });
});

describe("Telnyx callbacks", () => {
  it("maps TeXML status callbacks and AI conversation transcripts", () => {
    const form = parseTelnyxBody("CallSid=v3%3Aabc&CallStatus=completed&AnsweredBy=machine_end_beep", "application/x-www-form-urlencoded");
    expect(mapTelnyxCallback(form, "att1")).toMatchObject({ provider: "telnyx", providerCallId: "v3:abc", attemptId: "att1", type: "call_ended", status: "VOICEMAIL" });
    expect(mapTelnyxCallback({ CallSid: "v3:abc", CallStatus: "no-answer" }, "att1")).toMatchObject({ status: "NO_ANSWER" });
    expect(mapTelnyxCallback({ CallSid: "v3:abc", CallStatus: "answered" }, "att1")).toMatchObject({ type: "call_answered" });
    const conv = { data: { event_type: "call.conversation.ended", payload: { conversation_id: "c1", messages: [{ role: "assistant", content: "Hi, is this Sam?" }, { role: "user", content: "Yes" }, { role: "tool", content: "{}" }] } } };
    expect(mapTelnyxCallback(conv, "att1")).toMatchObject({ type: "call_ended", eventId: "conversation_ended:c1", transcript: [{ speaker: "agent", text: "Hi, is this Sam?" }, { speaker: "driver", text: "Yes" }] });
    expect(mapTelnyxCallback({ CallSid: "x", CallStatus: "weird" }, undefined)).toBeNull();
  });
});
