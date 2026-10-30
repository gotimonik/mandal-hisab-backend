import { describe, expect, it } from "vitest";
import { latinName } from "@/lib/transliterate";

const words = (s: string | null) => new Set((s ?? "").split(" "));

describe("latinName", () => {
  it("leaves English names alone", () => {
    expect(latinName("Future Saving")).toBeNull();
    expect(latinName("A-9 Yuva Mandal")).toBeNull();
  });

  it("spells Gujarati names the way people type them", () => {
    expect(latinName("ગોટી પરિવાર મંડળ")).toBe("goti parivar mandal gotee parivar mandal");
    expect(latinName("પટેલ સમાજ")).toBe("patel samaj");
    expect(latinName("જય અંબે ગ્રુપ")).toBe("jay ambe grup");
    expect(words(latinName("ખોડિયાર માતા મંડળ"))).toContain("mata");
  });

  it("keeps both the plain and the popular spelling", () => {
    const w = words(latinName("શ્રી ગણેશ યુવક મંડળ"));
    for (const x of ["sri", "shree", "ganes", "ganesh", "yuvak", "mandal"]) expect(w).toContain(x);
  });

  it("handles Hindi and mixed names", () => {
    expect(words(latinName("श्री कृष्ण मंडल"))).toContain("krushna");
    expect(latinName("A-9 યુવા મંડળ")).toBe("a-9 yuva mandal");
  });
});
