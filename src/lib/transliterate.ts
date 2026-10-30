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
 * How people type a sound in English. All styles are stored for search, so any of them matches:
 *  - plain:   sri ganes, krisna, jnan
 *  - popular: shree ganesh, krushna, gnan
 *  - display: shri ganesh, krishna, gnan (also the suggestion shown to admins)
 */
type Style = "plain" | "popular" | "display";
const SPELL: Record<Style, { sh: string; ii: string; uu: string; ri: string; gn: string }> = {
  plain: { sh: "s", ii: "i", uu: "u", ri: "ri", gn: "jn" },
  popular: { sh: "sh", ii: "ee", uu: "oo", ri: "ru", gn: "gn" },
  display: { sh: "sh", ii: "i", uu: "u", ri: "ri", gn: "gn" },
};

/** One IAST word → English letters in the given style. */
function romanize(iastWord: string, style: Style): string {
  const sp = SPELL[style];
  // ળ comes out as "l" + a combining mark (no precomposed form): make it one letter
  let s = iastWord.toLowerCase().normalize("NFC").replace(/l\u0324/g, "ḷ");
  // anusvara / candrabindu: "m" before p, b, m (Ambe); "n" otherwise (Mandal, Sangh)
  s = s.replace(/(ṃ|ṁ|m̐)(?=[pbm])/g, "m").replace(/ṃ|ṁ|m̐/g, "n");
  // the silent final "a" (schwa) after a single consonant: jaya → jay, maṇḍaḷa → maṇḍaḷ.
  // Kept after a cluster (kṛṣṇa → krushna, mitra) and in short words; long ā is never dropped.
  if (s.length > 2 && /[aāiīuūeoṛ](kh|gh|ch|jh|ṭh|ḍh|th|dh|ph|bh|[^aāiīuūeoṛ])a$/.test(s)) s = s.slice(0, -1);
  s = s.replace(/jñ/g, sp.gn);
  s = s.replace(/ch/g, "§").replace(/c/g, "ch").replace(/§/g, "chh"); // IAST c = ch, ch = chh
  s = s.replace(/[śṣ]/g, sp.sh);
  s = s.replace(/ī/g, sp.ii).replace(/ū/g, sp.uu);
  s = s.replace(/ṛ/g, sp.ri);
  // drop the remaining marks (ā→a, ṇ→n, ṭ→t, ḍ→d, ḷ→l …) and anything that isn't a letter or digit
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** The name in one English-letter style, word by word (English words are kept as they are). */
function spell(name: string, style: Style): string {
  const out: string[] = [];
  for (const word of name.trim().split(/\s+/)) {
    const script = SCRIPTS.find((x) => x.re.test(word));
    out.push(script ? romanize(Sanscript.t(word, script.scheme, "iast"), style) : word.toLowerCase());
  }
  return out.filter(Boolean).join(" ");
}

/** English-letter spellings of a name with Gujarati/Hindi in it; null when it's already in English. */
export function latinName(name: string): string | null {
  if (!hasIndic(name)) return null;
  const phrases = [...new Set((["plain", "popular", "display"] as const).map((st) => spell(name, st)).filter(Boolean))];
  return phrases.join(" ") || null;
}

/** A readable English spelling to suggest to admins ("Shri Ganesh Yuvak Mandal"); null for English names. */
export function suggestEnglishName(name: string): string | null {
  if (!hasIndic(name)) return null;
  return spell(name, "display").replace(/(^|\s)([a-z])/g, (_, sp: string, c: string) => sp + c.toUpperCase()) || null;
}

/**
 * What gets stored in `nameLatin` and searched: the automatic spellings plus any spellings the
 * admin typed in settings ("Goti Parivar, Gotee Family").
 */
export function searchSpellings(name: string, nameEnglish?: string | null): string | null {
  const custom = (nameEnglish ?? "").toLowerCase().replace(/[,;/]+/g, " ").replace(/\s+/g, " ").trim();
  return [latinName(name), custom].filter(Boolean).join(" ") || null;
}
