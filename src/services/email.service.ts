import { env } from "@/config/env";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}

/** Development / unconfigured provider: logs instead of sending. */
class LogEmailProvider implements EmailProvider {
  async send(msg: EmailMessage) {
    if (process.env.NODE_ENV !== "test") {
      console.info(`[email] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
    }
  }
}

/** Resend (https://resend.com) HTTP API provider. */
class ResendEmailProvider implements EmailProvider {
  constructor(private apiKey: string, private from: string) {}
  async send(msg: EmailMessage) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) console.error("Email send failed", res.status);
  }
}

let provider: EmailProvider | null = null;
export const sentEmails: EmailMessage[] = []; // test inspection

export function emailProvider(): EmailProvider {
  if (provider) return provider;
  const e = env();
  provider = e.RESEND_API_KEY ? new ResendEmailProvider(e.RESEND_API_KEY, e.EMAIL_FROM) : new LogEmailProvider();
  return provider;
}

export async function sendEmail(msg: EmailMessage) {
  if (process.env.NODE_ENV === "test") {
    sentEmails.push(msg);
    return;
  }
  try {
    await emailProvider().send(msg);
  } catch (e) {
    console.error("Email provider error", e);
  }
}
