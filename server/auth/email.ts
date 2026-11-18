import { Resend } from "resend";
import { env } from "../config/env.js";

const EMAIL_FROM = "Lizzor <noreply@send.lizzor.com>";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Providers should forward this as their native idempotency key. */
  idempotencyKey?: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<{ providerMessageId?: string }>;
}

const developmentOutbox: EmailMessage[] = [];

class DevelopmentEmailService implements EmailService {
  async send(message: EmailMessage): Promise<{ providerMessageId?: string }> {
    if (env.NODE_ENV === "production") {
      throw new Error("Transactional email provider is not configured.");
    }
    developmentOutbox.push(message);
    console.info("Development email queued", { to: message.to, subject: message.subject });
    return { providerMessageId: `development-${developmentOutbox.length}` };
  }
}

class ResendEmailService implements EmailService {
  private client?: Resend;

  async send(message: EmailMessage): Promise<{ providerMessageId?: string }> {
    if (!env.RESEND_API_KEY) {
      throw new Error("Transactional email provider is not configured.");
    }
    this.client ??= new Resend(env.RESEND_API_KEY);
    const { data, error } = await this.client.emails.send(
      {
        from: EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      },
      message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
    );
    if (error) throw new Error(`Transactional email provider rejected the message (${error.name ?? "provider_error"}).`);
    if (!data?.id) throw new Error("Transactional email provider returned no message identifier.");
    return { providerMessageId: data.id };
  }
}

export const emailProviderConfigured = Boolean(env.RESEND_API_KEY);
export const emailService: EmailService = env.NODE_ENV === "production"
  ? new ResendEmailService()
  : new DevelopmentEmailService();

export function getDevelopmentOutbox(): readonly EmailMessage[] {
  return developmentOutbox;
}