import { formatMoney } from "@/lib/currency";

/**
 * The words of every notification, in English, Gujarati and Hindi.
 *
 * A notification stores a `key` and its `params` (amounts in paise, dates as ISO strings, names
 * as text). The words are put together when it's read — in the reader's language — so the
 * in-app list and the phone push always match the language the person picked.
 * Pushes also get the Mandal's name in the title (see push.service), so it's clear which
 * Mandal it's about when someone is in more than one.
 */

export type Lang = "en" | "gu" | "hi";
export const isLang = (v: unknown): v is Lang => v === "en" || v === "gu" || v === "hi";

export type CopyParams = Record<string, string | number | null | undefined>;
export interface NotificationCopy {
  key: CopyKey;
  /** `cur` is the Mandal's currency; keys ending in Paise are money, in Date are dates, in Month are YYYY-MM months. */
  params: CopyParams;
}

/** Build the stored copy for a notification. */
export function copy(key: CopyKey, params: CopyParams, currency: string): NotificationCopy {
  return { key, params: { ...params, cur: currency } };
}

/* ------------------------------------------------------------------ formatting helpers */

const LOCALE: Record<Lang, string> = { en: "en-IN", gu: "gu-IN", hi: "hi-IN" };
const METHOD: Record<Lang, Record<string, string>> = {
  en: { cash: "cash", upi: "UPI", bank: "bank transfer", bank_transfer: "bank transfer", cheque: "cheque", card: "card" },
  gu: { cash: "રોકડ", upi: "UPI", bank: "બેંક ટ્રાન્સફર", bank_transfer: "બેંક ટ્રાન્સફર", cheque: "ચેક", card: "કાર્ડ" },
  hi: { cash: "नकद", upi: "UPI", bank: "बैंक ट्रांसफ़र", bank_transfer: "बैंक ट्रांसफ़र", cheque: "चेक", card: "कार्ड" },
};

interface F {
  lang: Lang;
  /** text */
  s(k: string): string;
  n(k: string): number;
  has(k: string): boolean;
  /** money (key holds paise) */
  m(k: string): string;
  /** date (key holds an ISO date) — "05 Nov 2026" in the reader's language */
  d(k: string): string;
  /** month (key holds YYYY-MM) — "November 2026" */
  month(k: string): string;
  /** payment method — "cash" / "રોકડ" / "नकद" */
  method(k: string): string;
}

function fmt(lang: Lang, p: CopyParams): F {
  const cur = String(p.cur ?? "INR");
  const raw = (k: string) => p[k];
  return {
    lang,
    s: (k) => String(raw(k) ?? ""),
    n: (k) => Number(raw(k) ?? 0),
    has: (k) => raw(k) !== undefined && raw(k) !== null && raw(k) !== "" && raw(k) !== 0,
    m: (k) => formatMoney(Number(raw(k) ?? 0), cur),
    d: (k) => {
      const v = raw(k);
      if (!v) return "";
      return new Intl.DateTimeFormat(LOCALE[lang], { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC", numberingSystem: "latn" }).format(new Date(String(v)));
    },
    month: (k) => {
      const v = String(raw(k) ?? "");
      if (!/^\d{4}-\d{2}$/.test(v)) return v;
      return new Intl.DateTimeFormat(LOCALE[lang], { month: "long", year: "numeric", timeZone: "UTC", numberingSystem: "latn" }).format(new Date(`${v}-01T00:00:00Z`));
    },
    method: (k) => METHOD[lang][String(raw(k) ?? "")] ?? String(raw(k) ?? ""),
  };
}

type Words = { title: string; body: string };
type Tpl = (f: F) => Words;

/** "in 3 days" / "tomorrow" / "today" */
const inDays = (f: F, en: [string, string, string], gu: [string, string, string], hi: [string, string, string]) => {
  const d = f.n("days");
  const [today, tomorrow, later] = f.lang === "gu" ? gu : f.lang === "hi" ? hi : en;
  return d === 0 ? today : d === 1 ? tomorrow : later.replace("{n}", String(d));
};
/** "Diwali fund · Oct 2026" — the scheme (when known) and the period */
const schemePeriod = (f: F) => [f.s("scheme"), f.s("period")].filter(Boolean).join(" · ");
const reason = (f: F) => (f.has("reason") ? f.s("reason") : "");

/* ------------------------------------------------------------------ the copy */

const COPY = {
  /* ---- payments */
  "payment.pending": {
    en: (f) => ({ title: "Payment to verify", body: `${f.m("amountPaise")} from ${f.s("payer")} is waiting for you to verify it. A receipt is issued once you do.` }),
    gu: (f) => ({ title: "ચુકવણીની ખાતરી કરો", body: `${f.s("payer")} તરફથી ${f.m("amountPaise")} તમારી ખાતરીની રાહ જુએ છે. ખાતરી પછી રસીદ બનશે.` }),
    hi: (f) => ({ title: "भुगतान जाँचें", body: `${f.s("payer")} से ${f.m("amountPaise")} आपकी जाँच का इंतज़ार कर रहा है। जाँच के बाद रसीद बनेगी।` }),
  },
  "payment.request": {
    en: (f) => ({ title: `${f.s("member")} says they paid`, body: `${f.m("amountPaise")} in ${f.method("method")} for ${f.s("purpose") === "other" ? `“${f.s("note")}”` : f.has("scheme") ? f.s("scheme") : "monthly hapta"}. Verify it to issue a receipt.` }),
    gu: (f) => ({ title: `${f.s("member")} એ ચુકવણી કરી`, body: `${f.s("purpose") === "other" ? `“${f.s("note")}”` : f.has("scheme") ? f.s("scheme") : "માસિક હપ્તા"} માટે ${f.method("method")} માં ${f.m("amountPaise")}. ખાતરી કરીને રસીદ આપો.` }),
    hi: (f) => ({ title: `${f.s("member")} ने भुगतान किया`, body: `${f.s("purpose") === "other" ? `“${f.s("note")}”` : f.has("scheme") ? f.s("scheme") : "मासिक हफ़्ते"} के लिए ${f.method("method")} में ${f.m("amountPaise")}। जाँच कर रसीद दें।` }),
  },
  "payment.verified": {
    en: (f) => ({ title: "Payment received", body: `Your payment of ${f.m("amountPaise")} is verified. Your receipt is ready.` }),
    gu: (f) => ({ title: "ચુકવણી મળી ગઈ", body: `તમારી ${f.m("amountPaise")} ની ચુકવણીની ખાતરી થઈ ગઈ. તમારી રસીદ તૈયાર છે.` }),
    hi: (f) => ({ title: "भुगतान मिल गया", body: `आपके ${f.m("amountPaise")} के भुगतान की जाँच हो गई। आपकी रसीद तैयार है।` }),
  },
  "payment.rejected": {
    en: (f) => ({ title: "Payment not verified", body: `Your payment of ${f.m("amountPaise")} couldn't be verified${reason(f) ? `: ${reason(f)}` : ""}. Speak to your treasurer if this looks wrong.` }),
    gu: (f) => ({ title: "ચુકવણીની ખાતરી ન થઈ", body: `તમારી ${f.m("amountPaise")} ની ચુકવણીની ખાતરી ન થઈ${reason(f) ? `: ${reason(f)}` : ""}. ભૂલ લાગે તો ખજાનચી સાથે વાત કરો.` }),
    hi: (f) => ({ title: "भुगतान की जाँच नहीं हुई", body: `आपके ${f.m("amountPaise")} के भुगतान की जाँच नहीं हो पाई${reason(f) ? `: ${reason(f)}` : ""}। ग़लत लगे तो ख़ज़ांची से बात करें।` }),
  },

  /* ---- hapta reminders */
  "installment.reminder": {
    en: (f) => ({ title: `Hapta due ${inDays(f, ["today", "tomorrow", "in {n} days"], ["", "", ""], ["", "", ""])}`, body: `${schemePeriod(f)}: ${f.m("amountPaise")} to pay by ${f.d("dueDate")}.` }),
    gu: (f) => ({ title: `હપ્તો ${inDays(f, ["", "", ""], ["આજે ભરવાનો છે", "કાલે ભરવાનો છે", "{n} દિવસમાં ભરવાનો છે"], ["", "", ""])}`, body: `${schemePeriod(f)}: ${f.d("dueDate")} સુધીમાં ${f.m("amountPaise")} ભરવાના છે.` }),
    hi: (f) => ({ title: `हफ़्ता ${inDays(f, ["", "", ""], ["", "", ""], ["आज भरना है", "कल भरना है", "{n} दिन में भरना है"])}`, body: `${schemePeriod(f)}: ${f.d("dueDate")} तक ${f.m("amountPaise")} भरने हैं।` }),
  },
  "installment.overdue": {
    en: (f) => ({ title: "Hapta overdue", body: `${schemePeriod(f)}: ${f.m("amountPaise")} is ${f.n("lateDays")} days late. Please pay your treasurer.` }),
    gu: (f) => ({ title: "હપ્તો મોડો થયો", body: `${schemePeriod(f)}: ${f.m("amountPaise")} ${f.n("lateDays")} દિવસથી બાકી છે. કૃપા કરીને ખજાનચીને ભરો.` }),
    hi: (f) => ({ title: "हफ़्ता देर से", body: `${schemePeriod(f)}: ${f.m("amountPaise")} ${f.n("lateDays")} दिन से बाकी है। कृपया ख़ज़ांची को भरें।` }),
  },
  "installment.changed": {
    en: (f) => ({ title: "Hapta schedule changed", body: `${schemePeriod(f)}: the ${f.s("change") === "due_date" ? "due date" : "amount"} was changed${reason(f) ? ` — ${reason(f)}` : ""}.` }),
    gu: (f) => ({ title: "હપ્તાનું સમયપત્રક બદલાયું", body: `${schemePeriod(f)}: ${f.s("change") === "due_date" ? "ભરવાની તારીખ" : "રકમ"} બદલાઈ${reason(f) ? ` — ${reason(f)}` : ""}.` }),
    hi: (f) => ({ title: "हफ़्ते का समय बदला", body: `${schemePeriod(f)}: ${f.s("change") === "due_date" ? "भरने की तारीख़" : "रकम"} बदली गई${reason(f) ? ` — ${reason(f)}` : ""}।` }),
  },
  "scheme.assigned": {
    en: (f) => ({ title: "Added to a hapta scheme", body: `You're now in ${f.s("scheme")}${f.has("amountPaise") ? ` — ${f.m("amountPaise")} per installment` : ""}.` }),
    gu: (f) => ({ title: "હપ્તા યોજનામાં ઉમેર્યા", body: `હવે તમે ${f.s("scheme")} માં છો${f.has("amountPaise") ? ` — હપ્તા દીઠ ${f.m("amountPaise")}` : ""}.` }),
    hi: (f) => ({ title: "हफ़्ता योजना में जोड़ा गया", body: `अब आप ${f.s("scheme")} में हैं${f.has("amountPaise") ? ` — प्रति हफ़्ता ${f.m("amountPaise")}` : ""}।` }),
  },

  /* ---- loans (EMI) */
  "loan.reminder": {
    en: (f) => ({ title: `Loan installment due ${inDays(f, ["today", "tomorrow", "in {n} days"], ["", "", ""], ["", "", ""])}`, body: `${f.s("loan")}, installment ${f.n("sequence")}: ${f.m("amountPaise")} to pay by ${f.d("dueDate")}.` }),
    gu: (f) => ({ title: `લોનનો હપ્તો ${inDays(f, ["", "", ""], ["આજે ભરવાનો છે", "કાલે ભરવાનો છે", "{n} દિવસમાં ભરવાનો છે"], ["", "", ""])}`, body: `${f.s("loan")}, હપ્તો ${f.n("sequence")}: ${f.d("dueDate")} સુધીમાં ${f.m("amountPaise")} ભરવાના છે.` }),
    hi: (f) => ({ title: `लोन की किस्त ${inDays(f, ["", "", ""], ["", "", ""], ["आज भरनी है", "कल भरनी है", "{n} दिन में भरनी है"])}`, body: `${f.s("loan")}, किस्त ${f.n("sequence")}: ${f.d("dueDate")} तक ${f.m("amountPaise")} भरने हैं।` }),
  },
  "loan.approved": {
    en: (f) => ({ title: "Loan approved", body: `Your loan ${f.s("loan")} of ${f.m("amountPaise")} is approved.` }),
    gu: (f) => ({ title: "લોન મંજૂર", body: `તમારી ${f.m("amountPaise")} ની લોન ${f.s("loan")} મંજૂર થઈ ગઈ.` }),
    hi: (f) => ({ title: "लोन मंज़ूर", body: `आपका ${f.m("amountPaise")} का लोन ${f.s("loan")} मंज़ूर हो गया।` }),
  },
  "loan.rejected": {
    en: (f) => ({ title: "Loan not approved", body: `Your loan application ${f.s("loan")} wasn't approved${reason(f) ? `: ${reason(f)}` : ""}.` }),
    gu: (f) => ({ title: "લોન મંજૂર ન થઈ", body: `તમારી લોન અરજી ${f.s("loan")} મંજૂર ન થઈ${reason(f) ? `: ${reason(f)}` : ""}.` }),
    hi: (f) => ({ title: "लोन मंज़ूर नहीं हुआ", body: `आपका लोन आवेदन ${f.s("loan")} मंज़ूर नहीं हुआ${reason(f) ? `: ${reason(f)}` : ""}।` }),
  },
  "loan.rate_changed": {
    en: (f) => ({ title: "Loan interest changed", body: `${f.s("loan")}: interest is ${f.s("rate")}% a year from ${f.d("fromDate")}. Your schedule is updated.` }),
    gu: (f) => ({ title: "લોનનું વ્યાજ બદલાયું", body: `${f.s("loan")}: ${f.d("fromDate")} થી વ્યાજ વાર્ષિક ${f.s("rate")}% છે. તમારું સમયપત્રક અપડેટ થયું.` }),
    hi: (f) => ({ title: "लोन का ब्याज बदला", body: `${f.s("loan")}: ${f.d("fromDate")} से ब्याज सालाना ${f.s("rate")}% है। आपका शेड्यूल अपडेट हो गया।` }),
  },

  /* ---- upad (loans from the Mandal fund) */
  "upadRequest.new": {
    en: (f) => ({ title: "Upad request", body: `${f.s("member")} asked for ${f.m("amountPaise")} upad${f.has("purpose") ? ` — ${f.s("purpose")}` : ""}. Approve or decline it in Upad.` }),
    gu: (f) => ({ title: "ઉપાડની માંગણી", body: `${f.s("member")} એ ${f.m("amountPaise")} ઉપાડ માંગ્યો${f.has("purpose") ? ` — ${f.s("purpose")}` : ""}. ઉપાડમાં મંજૂર કે નામંજૂર કરો.` }),
    hi: (f) => ({ title: "उपाड़ की माँग", body: `${f.s("member")} ने ${f.m("amountPaise")} उपाड़ माँगा${f.has("purpose") ? ` — ${f.s("purpose")}` : ""}। उपाड़ में मंज़ूर या नामंज़ूर करें।` }),
  },
  "upadRequest.rejected": {
    en: (f) => ({ title: "Upad request not approved", body: `Your request for ${f.m("amountPaise")} wasn't approved${reason(f) ? `: ${reason(f)}` : ""}.` }),
    gu: (f) => ({ title: "ઉપાડની માંગણી મંજૂર ન થઈ", body: `તમારી ${f.m("amountPaise")} ની માંગણી મંજૂર ન થઈ${reason(f) ? `: ${reason(f)}` : ""}.` }),
    hi: (f) => ({ title: "उपाड़ की माँग मंज़ूर नहीं हुई", body: `आपकी ${f.m("amountPaise")} की माँग मंज़ूर नहीं हुई${reason(f) ? `: ${reason(f)}` : ""}।` }),
  },
  "fundLoan.given": {
    en: (f) => ({ title: "Upad given to you", body: `${f.m("amountPaise")} upad (${f.s("number")}). Interest: ${f.s("rate")}% a month, from ${f.month("fromMonth")}.` }),
    gu: (f) => ({ title: "તમને ઉપાડ મળ્યો", body: `${f.m("amountPaise")} ઉપાડ (${f.s("number")}). વ્યાજ: માસિક ${f.s("rate")}%, ${f.month("fromMonth")} થી.` }),
    hi: (f) => ({ title: "आपको उपाड़ मिला", body: `${f.m("amountPaise")} उपाड़ (${f.s("number")})। ब्याज: मासिक ${f.s("rate")}%, ${f.month("fromMonth")} से।` }),
  },
  "upadClaim.new": {
    en: (f) => ({ title: `${f.s("member")} paid upad`, body: `${[f.has("interestPaise") ? `${f.m("interestPaise")} interest` : "", f.has("principalPaise") ? `${f.m("principalPaise")} returned` : ""].filter(Boolean).join(" + ")} on ${f.s("loan")}, in ${f.method("method")}. Verify it to issue a receipt.` }),
    gu: (f) => ({ title: `${f.s("member")} એ ઉપાડની ચુકવણી કરી`, body: `${f.s("loan")} પર ${f.method("method")} માં ${[f.has("interestPaise") ? `${f.m("interestPaise")} વ્યાજ` : "", f.has("principalPaise") ? `${f.m("principalPaise")} પરત` : ""].filter(Boolean).join(" + ")}. ખાતરી કરીને રસીદ આપો.` }),
    hi: (f) => ({ title: `${f.s("member")} ने उपाड़ चुकाया`, body: `${f.s("loan")} पर ${f.method("method")} में ${[f.has("interestPaise") ? `${f.m("interestPaise")} ब्याज` : "", f.has("principalPaise") ? `${f.m("principalPaise")} वापस` : ""].filter(Boolean).join(" + ")}। जाँच कर रसीद दें।` }),
  },
  "upadClaim.verified": {
    en: (f) => ({ title: "Upad payment received", body: `Your payment of ${f.m("amountPaise")} was received. Your receipt is ready.` }),
    gu: (f) => ({ title: "ઉપાડની ચુકવણી મળી", body: `તમારી ${f.m("amountPaise")} ની ચુકવણી મળી ગઈ. તમારી રસીદ તૈયાર છે.` }),
    hi: (f) => ({ title: "उपाड़ का भुगतान मिला", body: `आपका ${f.m("amountPaise")} का भुगतान मिल गया। आपकी रसीद तैयार है।` }),
  },
  "upadClaim.rejected": {
    en: (f) => ({ title: "Upad payment not verified", body: `Your payment of ${f.m("amountPaise")} couldn't be verified${reason(f) ? `: ${reason(f)}` : ""}.` }),
    gu: (f) => ({ title: "ઉપાડની ચુકવણીની ખાતરી ન થઈ", body: `તમારી ${f.m("amountPaise")} ની ચુકવણીની ખાતરી ન થઈ${reason(f) ? `: ${reason(f)}` : ""}.` }),
    hi: (f) => ({ title: "उपाड़ के भुगतान की जाँच नहीं हुई", body: `आपके ${f.m("amountPaise")} के भुगतान की जाँच नहीं हो पाई${reason(f) ? `: ${reason(f)}` : ""}।` }),
  },

  /* ---- savings */
  "interest.credited": {
    en: (f) => ({ title: "Interest added to your savings", body: `${f.m("amountPaise")} interest for ${f.month("periodMonth")}.` }),
    gu: (f) => ({ title: "તમારી બચતમાં વ્યાજ ઉમેરાયું", body: `${f.month("periodMonth")} નું ${f.m("amountPaise")} વ્યાજ.` }),
    hi: (f) => ({ title: "आपकी बचत में ब्याज जुड़ा", body: `${f.month("periodMonth")} का ${f.m("amountPaise")} ब्याज।` }),
  },
  "withdrawal.paid": {
    en: (f) => ({ title: "Savings paid out to you", body: `${f.m("amountPaise")} (${f.s("number")}). Your savings balance is now ${f.m("balancePaise")}.` }),
    gu: (f) => ({ title: "તમને બચત પરત મળી", body: `${f.m("amountPaise")} (${f.s("number")}). હવે તમારી બચત ${f.m("balancePaise")} છે.` }),
    hi: (f) => ({ title: "आपको बचत वापस मिली", body: `${f.m("amountPaise")} (${f.s("number")})। अब आपकी बचत ${f.m("balancePaise")} है।` }),
  },

  /* ---- expenses */
  "expense.pending": {
    en: (f) => ({ title: "Expense to approve", body: `${f.m("amountPaise")} to ${f.s("payee")} for ${f.s("category")}.` }),
    gu: (f) => ({ title: "ખર્ચ મંજૂર કરો", body: `${f.s("category")} માટે ${f.s("payee")} ને ${f.m("amountPaise")}.` }),
    hi: (f) => ({ title: "ख़र्च मंज़ूर करें", body: `${f.s("category")} के लिए ${f.s("payee")} को ${f.m("amountPaise")}।` }),
  },
  "expense.approved": {
    en: (f) => ({ title: "Expense approved", body: `${f.m("amountPaise")} to ${f.s("payee")} was approved.` }),
    gu: (f) => ({ title: "ખર્ચ મંજૂર થયો", body: `${f.s("payee")} ને ${f.m("amountPaise")} મંજૂર થયા.` }),
    hi: (f) => ({ title: "ख़र्च मंज़ूर हुआ", body: `${f.s("payee")} को ${f.m("amountPaise")} मंज़ूर हुए।` }),
  },
  "expense.rejected": {
    en: (f) => ({ title: "Expense not approved", body: `${f.m("amountPaise")} to ${f.s("payee")}${reason(f) ? `: ${reason(f)}` : ""}.` }),
    gu: (f) => ({ title: "ખર્ચ મંજૂર ન થયો", body: `${f.s("payee")} ને ${f.m("amountPaise")}${reason(f) ? `: ${reason(f)}` : ""}.` }),
    hi: (f) => ({ title: "ख़र्च मंज़ूर नहीं हुआ", body: `${f.s("payee")} को ${f.m("amountPaise")}${reason(f) ? `: ${reason(f)}` : ""}।` }),
  },

  /* ---- people */
  "membership.request": {
    en: (f) => ({ title: "New join request", body: `${f.s("name")} wants to join. Approve or decline in Users & joining.` }),
    gu: (f) => ({ title: "જોડાવાની નવી વિનંતી", body: `${f.s("name")} જોડાવા માંગે છે. વપરાશકર્તાઓ અને જોડાણમાં મંજૂર કે નામંજૂર કરો.` }),
    hi: (f) => ({ title: "जुड़ने की नई माँग", body: `${f.s("name")} जुड़ना चाहते हैं। यूज़र और जुड़ाव में मंज़ूर या नामंज़ूर करें।` }),
  },
  "membership.approve": {
    en: () => ({ title: "Welcome to the Mandal", body: "Your request to join was approved. You can now see the Mandal's hisab." }),
    gu: () => ({ title: "મંડળમાં સ્વાગત છે", body: "તમારી જોડાવાની વિનંતી મંજૂર થઈ. હવે તમે મંડળનો હિસાબ જોઈ શકો છો." }),
    hi: () => ({ title: "मंडल में स्वागत है", body: "आपकी जुड़ने की माँग मंज़ूर हो गई। अब आप मंडल का हिसाब देख सकते हैं।" }),
  },
  "membership.reject": {
    en: () => ({ title: "Join request declined", body: "Your request to join wasn't approved. Ask the Mandal admin if you think this is a mistake." }),
    gu: () => ({ title: "જોડાવાની વિનંતી નામંજૂર", body: "તમારી જોડાવાની વિનંતી મંજૂર ન થઈ. ભૂલ લાગે તો મંડળના એડમિનને પૂછો." }),
    hi: () => ({ title: "जुड़ने की माँग नामंज़ूर", body: "आपकी जुड़ने की माँग मंज़ूर नहीं हुई। ग़लत लगे तो मंडल के एडमिन से पूछें।" }),
  },
  "organization.status": {
    en: (f) => ({ title: { active: "Mandal approved", suspended: "Mandal suspended", rejected: "Mandal not approved", closed: "Mandal closed", archived: "Mandal archived" }[f.s("status")] ?? `Mandal ${f.s("status")}`, body: `${{ active: "Your Mandal is approved and ready to use.", suspended: "Your Mandal has been suspended.", rejected: "Your Mandal wasn't approved.", closed: "Your Mandal is closed.", archived: "Your Mandal is archived — its history stays available to read." }[f.s("status")] ?? `Your Mandal is now ${f.s("status")}.`}${reason(f) ? ` ${reason(f)}` : ""}` }),
    gu: (f) => ({ title: { active: "મંડળ મંજૂર", suspended: "મંડળ સ્થગિત", rejected: "મંડળ મંજૂર ન થયું", closed: "મંડળ બંધ", archived: "મંડળ આર્કાઇવ થયું" }[f.s("status")] ?? `મંડળ ${f.s("status")}`, body: `${{ active: "તમારું મંડળ મંજૂર થયું અને વાપરવા તૈયાર છે.", suspended: "તમારું મંડળ સ્થગિત કરાયું છે.", rejected: "તમારું મંડળ મંજૂર ન થયું.", closed: "તમારું મંડળ બંધ થયું.", archived: "તમારું મંડળ આર્કાઇવ થયું — તેનો હિસાબ વાંચવા માટે ઉપલબ્ધ રહેશે." }[f.s("status")] ?? `તમારું મંડળ હવે ${f.s("status")} છે.`}${reason(f) ? ` ${reason(f)}` : ""}` }),
    hi: (f) => ({ title: { active: "मंडल मंज़ूर", suspended: "मंडल निलंबित", rejected: "मंडल मंज़ूर नहीं हुआ", closed: "मंडल बंद", archived: "मंडल आर्काइव हुआ" }[f.s("status")] ?? `मंडल ${f.s("status")}`, body: `${{ active: "आपका मंडल मंज़ूर हो गया और इस्तेमाल के लिए तैयार है।", suspended: "आपका मंडल निलंबित किया गया है।", rejected: "आपका मंडल मंज़ूर नहीं हुआ।", closed: "आपका मंडल बंद हो गया।", archived: "आपका मंडल आर्काइव हुआ — इसका हिसाब पढ़ने के लिए उपलब्ध रहेगा।" }[f.s("status")] ?? `आपका मंडल अब ${f.s("status")} है।`}${reason(f) ? ` ${reason(f)}` : ""}` }),
  },

  /* ---- closing the Mandal */
  "settlement.started": {
    en: (f) => ({ title: "The Mandal is closing", body: `Your final payout will be ${f.m("netPaise")}: savings ${f.m("savingsPaise")}${f.has("mandalSharePaise") ? ` + your share of the Mandal's money ${f.m("mandalSharePaise")}` : ""}${f.has("upadOwedPaise") ? ` − upad still owed ${f.m("upadOwedPaise")}` : ""}.` }),
    gu: (f) => ({ title: "મંડળ બંધ થઈ રહ્યું છે", body: `તમને છેલ્લે ${f.m("netPaise")} મળશે: બચત ${f.m("savingsPaise")}${f.has("mandalSharePaise") ? ` + મંડળના પૈસામાં તમારો ભાગ ${f.m("mandalSharePaise")}` : ""}${f.has("upadOwedPaise") ? ` − બાકી ઉપાડ ${f.m("upadOwedPaise")}` : ""}.` }),
    hi: (f) => ({ title: "मंडल बंद हो रहा है", body: `आपको आख़िर में ${f.m("netPaise")} मिलेंगे: बचत ${f.m("savingsPaise")}${f.has("mandalSharePaise") ? ` + मंडल के पैसे में आपका हिस्सा ${f.m("mandalSharePaise")}` : ""}${f.has("upadOwedPaise") ? ` − बाकी उपाड़ ${f.m("upadOwedPaise")}` : ""}।` }),
  },
  "settlement.paid": {
    en: (f) => ({ title: "Final payout paid", body: `${f.m("netPaise")} was paid to you${f.has("upadPaise") ? ` (after upad ${f.m("upadPaise")})` : ""}. Thank you for being part of the Mandal.` }),
    gu: (f) => ({ title: "છેલ્લી ચુકવણી થઈ", body: `તમને ${f.m("netPaise")} ચૂકવાયા${f.has("upadPaise") ? ` (ઉપાડ ${f.m("upadPaise")} બાદ)` : ""}. મંડળનો ભાગ બનવા બદલ આભાર.` }),
    hi: (f) => ({ title: "आख़िरी भुगतान हुआ", body: `आपको ${f.m("netPaise")} दिए गए${f.has("upadPaise") ? ` (उपाड़ ${f.m("upadPaise")} के बाद)` : ""}। मंडल का हिस्सा बनने के लिए धन्यवाद।` }),
  },
  "settlement.closed": {
    en: () => ({ title: "Mandal closed", body: "All payouts are done and the Mandal is closed. Its history stays available to read." }),
    gu: () => ({ title: "મંડળ બંધ થયું", body: "બધી ચુકવણી થઈ ગઈ અને મંડળ બંધ થયું. તેનો હિસાબ વાંચવા માટે ઉપલબ્ધ રહેશે." }),
    hi: () => ({ title: "मंडल बंद हुआ", body: "सारे भुगतान हो गए और मंडल बंद हो गया। इसका हिसाब पढ़ने के लिए उपलब्ध रहेगा।" }),
  },
} satisfies Record<string, Record<Lang, Tpl>>;

export type CopyKey = keyof typeof COPY;
export const COPY_KEYS = Object.keys(COPY) as CopyKey[];

/** The title and body of a notification in a language (English if the key is unknown). */
export function renderCopy(lang: Lang, c: NotificationCopy): Words {
  const t = (COPY as Record<string, Record<Lang, Tpl>>)[c.key];
  if (!t) return { title: c.key, body: "" };
  return (t[lang] ?? t.en)(fmt(lang, c.params));
}
