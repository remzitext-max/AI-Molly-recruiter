import { describe, it, expect } from "vitest";
import { splitCaption } from "@/lib/telegram";

const shown = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").length;

describe("call recording caption", () => {
  it("keeps a short card whole", () => {
    expect(splitCaption("a\nb")).toEqual({ caption: "a\nb", rest: null });
  });

  it("cuts a long card at a line, even when the part before the notes is over 1024", () => {
    const head = Array.from({ length: 20 }, (_, i) => `🏢Companies ${i}: ${"A &amp; B ".repeat(8)}`);
    const text = [...head, "📝 Notes:", "x".repeat(500)].join("\n");
    const { caption, rest } = splitCaption(text);
    expect(shown(caption)).toBeLessThanOrEqual(1024);
    expect(caption.split("\n").every((l) => head.includes(l))).toBe(true);
    expect(rest).toContain("📝 Notes:");
    expect(caption + "\n" + rest).toBe(text);
  });

  it("puts the notes in the reply when the card itself fits", () => {
    const text = ["🗒Driver name: John", "📝 Notes:", "y".repeat(1100)].join("\n");
    expect(splitCaption(text)).toEqual({ caption: "🗒Driver name: John", rest: "📝 Notes:\n" + "y".repeat(1100) });
  });
});
