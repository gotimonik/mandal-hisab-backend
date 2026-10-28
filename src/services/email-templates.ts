import { env } from "@/config/env";

/**
 * Branded layout shared by every MandalHisab email.
 *
 * Email clients are not browsers: everything is tables + inline styles, no web fonts,
 * no SVG, solid colour fallbacks behind gradients, and a plain-text version is always
 * sent alongside. The logo is served from the website (/email/logo.png) and the name
 * is also written in text, so it still reads right when images are blocked.
 */

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const C = {
  brand: "#4f46e5",
  brandDeep: "#6d28d9",
  ink: "#1f1d2e",
  muted: "#6b6880",
  line: "#ece9f6",
  page: "#f4f2fb",
  soft: "#f7f5ff",
} as const;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans Gujarati','Noto Sans Devanagari',sans-serif";

export interface EmailContent {
  /** Short line shown next to the subject in the inbox list. */
  preheader: string;
  heading: string;
  /** Greeting line, e.g. "Namaste Asha," */
  greeting?: string;
  /** Paragraphs. Plain strings are escaped; use { html } only for trusted, pre-escaped markup. */
  paragraphs: (string | { html: string; text: string })[];
  /** Optional key/value box (e.g. Mandal, invited by). Values are escaped. */
  details?: { label: string; value: string }[];
  button: { label: string; url: string };
  /** Small print under the button (expiry, "ignore if this wasn't you"). */
  note?: string;
  /** Why they got this email — shown in the footer. */
  reason: string;
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const site = env().FRONTEND_URL.replace(/\/$/, "");
  const logo = `${site}/email/logo.png`;
  const p = (s: EmailContent["paragraphs"][number]) => (typeof s === "string" ? esc(s) : s.html);
  const url = esc(c.button.url);

  const details = c.details?.length
    ? `<tr><td style="padding:4px 0 20px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:14px">
          ${c.details
            .map(
              (d, i) => `<tr><td style="padding:${i === 0 ? "14px" : "8px"} 16px ${i === c.details!.length - 1 ? "14px" : "0"};font:13px/1.4 ${FONT};color:${C.muted};width:38%;vertical-align:top">${esc(d.label)}</td>
                <td style="padding:${i === 0 ? "14px" : "8px"} 16px ${i === c.details!.length - 1 ? "14px" : "0"} 0;font:600 14px/1.4 ${FONT};color:${C.ink};vertical-align:top">${esc(d.value)}</td></tr>`,
            )
            .join("")}
        </table>
      </td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(c.preheader)}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}">
<tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <!-- header -->
    <tr><td bgcolor="${C.brand}" style="background:${C.brand};background-image:linear-gradient(135deg,${C.brand},${C.brandDeep});border-radius:20px 20px 0 0;padding:26px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:12px"><a href="${esc(site)}" style="text-decoration:none"><img src="${esc(logo)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:12px;border:2px solid #8b85f0;background:#6c63e8"></a></td>
        <td style="vertical-align:middle">
          <a href="${esc(site)}" style="text-decoration:none;font:800 22px/1.1 ${FONT};color:#ffffff;letter-spacing:-0.3px">MandalHisab</a>
          <div style="font:13px/1.4 ${FONT};color:#e0dcff;padding-top:3px">Transparent hisab for your Mandal</div>
        </td>
      </tr></table>
    </td></tr>
    <!-- body -->
    <tr><td style="background:#ffffff;padding:30px 28px 8px;border-left:1px solid ${C.line};border-right:1px solid ${C.line}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font:800 24px/1.25 ${FONT};color:${C.ink};padding-bottom:14px;letter-spacing:-0.3px">${esc(c.heading)}</td></tr>
        ${c.greeting ? `<tr><td style="font:16px/1.6 ${FONT};color:${C.ink};padding-bottom:10px">${esc(c.greeting)}</td></tr>` : ""}
        ${c.paragraphs.map((x) => `<tr><td style="font:16px/1.6 ${FONT};color:${C.ink};padding-bottom:14px">${p(x)}</td></tr>`).join("")}
        ${details}
        <tr><td style="padding:6px 0 22px">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td bgcolor="${C.brand}" style="border-radius:14px;background:${C.brand}">
              <a href="${url}" style="display:inline-block;padding:15px 28px;font:700 16px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:14px">${esc(c.button.label)} &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        ${c.note ? `<tr><td style="font:14px/1.55 ${FONT};color:${C.muted};padding-bottom:18px">${esc(c.note)}</td></tr>` : ""}
        <tr><td style="border-top:1px solid ${C.line};padding:16px 0 22px;font:12px/1.55 ${FONT};color:${C.muted}">
          Button not working? Copy this link into your browser:<br>
          <a href="${url}" style="color:${C.brand};word-break:break-all">${url}</a>
        </td></tr>
      </table>
    </td></tr>
    <!-- footer -->
    <tr><td style="background:#ffffff;border:1px solid ${C.line};border-top:0;border-radius:0 0 20px 20px;padding:0 28px 22px"></td></tr>
    <tr><td align="center" style="padding:20px 16px 0;font:12px/1.6 ${FONT};color:${C.muted}">
      ${esc(c.reason)}<br>
      <a href="${esc(site)}" style="color:${C.muted};text-decoration:underline">MandalHisab</a> · Hapta, upad and savings — simple and clear<br>
      <a href="${esc(site)}/contact" style="color:${C.muted};text-decoration:underline">Contact us</a> · <a href="${esc(site)}/privacy" style="color:${C.muted};text-decoration:underline">Privacy</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    c.heading,
    "",
    ...(c.greeting ? [c.greeting, ""] : []),
    ...c.paragraphs.flatMap((x) => [typeof x === "string" ? x : x.text, ""]),
    ...(c.details?.length ? [...c.details.map((d) => `${d.label}: ${d.value}`), ""] : []),
    `${c.button.label}: ${c.button.url}`,
    "",
    ...(c.note ? [c.note, ""] : []),
    "—",
    "MandalHisab · Transparent hisab for your Mandal",
    site,
    "",
    c.reason,
  ].join("\n");

  return { html, text };
}
