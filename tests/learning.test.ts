import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { answerQuestionGroup, computeStats, decideSuggestion, openQuestionGroups, parseModelReply, runLearningReport, type CallSample } from "@/lib/learning";
import { pitchFor } from "@/lib/pitch";
import { addLead, resetDb, seedBase } from "./helpers";

const call = (good: boolean, lines: [string, string][]): CallSample => ({ attemptId: "a", good, seconds: 60, result: good ? "Need to talk" : "Not interested", turns: lines.map(([speaker, text]) => ({ speaker, text })) });

describe("Crystal learning", () => {
  it("counts talks, good calls and the line drivers hung up after", () => {
    const s = computeStats([
      call(true, [["agent", "Hi"], ["driver", "yes"], ["agent", "85 cents"], ["driver", "nice"]]),
      call(false, [["agent", "Hi"], ["driver", "yes"], ["agent", "Which company are you driving for?"], ["driver", "bye"]]),
      call(false, [["agent", "Hi"], ["driver", "who"], ["agent", "Which company are you driving for?"], ["driver", "no"], ["tool", "[hangup]"]]),
      call(false, [["agent", "Hi"]]),
    ], 1, 2);
    expect(s).toMatchObject({ answeredCalls: 4, talked: 3, good: 1, goodRate: 33, hired: 1, openQuestions: 2 });
    expect(s.dropOffs[0]).toEqual({ line: "Which company are you driving for?", count: 2 });
  });

  it("keeps only real pitch fields and at most 5 suggestions from the model", () => {
    const r = parseModelReply('ok {"summary":"Drivers liked the pay.","suggestions":[{"field":"hook","title":"Shorter opener","why":"long openers lost drivers","proposed":"Up to 85 cents a mile. How many miles do you run?"},{"field":"salary","title":"x","why":"y","proposed":"z"},{"field":null,"title":"Advice","why":"w","proposed":null}]}');
    expect(r.summary).toBe("Drivers liked the pay.");
    expect(r.suggestions.map((s) => s.field)).toEqual(["hook", null, null]);
    expect(parseModelReply("not json").suggestions).toEqual([]);
  });

  it("changes the pitch only when the owner accepts, and answers questions into the offer draft", async () => {
    await resetDb();
    const base = await seedBase();
    await db.campaign.update({ where: { id: base.campaign.id }, data: { isDemo: false } });
    const report = await runLearningReport(base.org.id);
    expect(report.summary).toMatch(/Too few calls/);
    const s = await db.learningSuggestion.create({ data: { reportId: report.id, orgId: base.org.id, field: "hook", title: "Shorter opener", why: "test", proposed: "Up to 85 cents a mile. How many miles do you run?" } });
    expect((await pitchFor(base.org)).hook).toContain("great news");
    expect(await decideSuggestion(base.admin, s.id, true)).toEqual({ ok: true });
    expect((await pitchFor(await db.organization.findUniqueOrThrow({ where: { id: base.org.id } }))).hook).toBe("Up to 85 cents a mile. How many miles do you run?");
    expect(await decideSuggestion(base.admin, s.id, false)).toHaveProperty("error");

    const r = await addLead(base);
    if (r.result !== "created") throw new Error("no lead");
    await db.unansweredQuestion.createMany({ data: [{ leadId: r.leadId, question: "Do you allow pets?" }, { leadId: r.leadId, question: "do you allow pets" }] });
    const groups = await openQuestionGroups(base.org.id);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids).toHaveLength(2);
    const a = await answerQuestionGroup(base.admin, base.org.id, groups[0].ids, groups[0].question, "Yes, one small pet with a deposit.");
    expect(a).toMatchObject({ ok: true, version: 2 });
    const draft = await db.offerVersion.findFirstOrThrow({ where: { offerId: base.offer.id, status: "DRAFT" } });
    expect(JSON.stringify(draft.facts)).toContain("one small pet with a deposit");
    expect(await openQuestionGroups(base.org.id)).toHaveLength(0);
  });
});
