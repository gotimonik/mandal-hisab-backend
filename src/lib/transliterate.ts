/**
 * English-letter spellings of Gujarati / Hindi names, so "goti" finds "ગોટી પરિવાર મંડળ".
 * Stored on the Mandal as `nameLatin` and searched next to `name` (see search-index.ts).
 */
import Sanscript from "@indic-transliteration/sanscript";

const SCRIPTS = [
  { scheme: "gujarati", re: /[઀-૿]/ },
  { scheme: "devanagari", re: /[ऀ-ॿ]/ },
] as const;

const hasIndic = (s: string) => SCRIPTS.some((x) => x.re.test(s));

/**
 * One IAST word → how people actually type it in English.
 * `common` picks the popular spellings (shree, ganesh, krushna, gnan); otherwise the plain ones
 * (sri, ganes, krisna, jnan). Both are stored, so either kind of typing matches.
 */
function romanize(iastWord: string, common: boolean): string {
  // ળ comes out as "l" + a combining mark (no precomposed form): make it one letter
  let s = iastWord.toLowerCase().normalize("NFC").replace(/l\u0324/g, "ḷ");
  // anusvara / candrabindu: "m" before p, b, m (Ambe); "n" otherwise (Mandal, Sangh)
  s = s.replace(/(ṃ|ṁ|m̐)(?=[pbm])/g, "m").replace(/ṃ|ṁ|m̐/g, "n");
  // the silent final "a" (schwa) after a single consonant: jaya → jay, maṇḍaḷa → maṇḍaḷ.
  // Kept after a cluster (kṛṣṇa → krushna, mitra) and in short words; long ā is never dropped.
  if (s.length > 2 && /[aāiīuūeoṛ](kh|gh|ch|jh|ṭh|ḍh|th|dh|ph|bh|[^aāiīuūeoṛ])a$/.test(s)) s = s.slice(0, -1);
  s = s.replace(/jñ/g, common ? "gn" : "jn");
  s = s.replace(/ch/g, "§").replace(/c/g, "ch").replace(/§/g, "chh"); // IAST c = ch, ch = chh
  s = s.replace(/[śṣ]/g, common ? "sh" : "s");
  s = s.replace(/ī/g, common ? "ee" : "i").replace(/ū/g, common ? "oo" : "u");
  s = s.replace(/ṛ/g, common ? "ru" : "ri");
  // drop the remaining marks (ā→a, ṇ→n, ṭ→t, ḍ→d, ḷ→l …) and anything that isn't a letter or digit
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** English-letter spellings of a name with Gujarati/Hindi in it; null when it's already in English. */
export function latinName(name: string): string | null {
  if (!hasIndic(name)) return null;
  const plain: string[] = [];
  const common: string[] = [];
  for (const word of name.trim().split(/\s+/)) {
    const script = SCRIPTS.find((x) => x.re.test(word));
    if (!script) {
      const w = word.toLowerCase();
      plain.push(w);
      common.push(w);
      continue;
    }
    const iast = Sanscript.t(word, script.scheme, "iast");
    plain.push(romanize(iast, false));
    common.push(romanize(iast, true));
  }
  const a = plain.filter(Boolean).join(" ");
  const b = common.filter(Boolean).join(" ");
  return (a === b ? a : `${a} ${b}`) || null;
}
