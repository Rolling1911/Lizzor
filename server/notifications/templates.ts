import { env } from "../config/env.js";
import type { NotificationEventType } from "./service.js";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

const presentation: Record<NotificationEventType, { eyebrow: string; action: string }> = {
  "order.created": { eyebrow: "ORDER CONFIRMATION", action: "View your order" },
  "payment.succeeded": { eyebrow: "PAYMENT CONFIRMATION", action: "View payment details" },
  "payment.failed": { eyebrow: "PAYMENT UPDATE", action: "Review your order" },
  "refund.completed": { eyebrow: "REFUND CONFIRMATION", action: "View refund details" },
  "refund.updated": { eyebrow: "REFUND UPDATE", action: "View refund details" },
  "order.cancelled": { eyebrow: "ORDER CANCELLED", action: "View your order" },
  "shipment.created": { eyebrow: "ORDER PROCESSING", action: "Track your order" },
  "fulfillment.shipped": { eyebrow: "ORDER SHIPPED", action: "Track your shipment" },
  "fulfillment.delivered": { eyebrow: "ORDER DELIVERED", action: "View your order" },
  "return.requested": { eyebrow: "RETURN CONFIRMATION", action: "View your return" },
  "return.updated": { eyebrow: "RETURN UPDATE", action: "View your return" },
  "company.invitation": { eyebrow: "COMPANY INVITATION", action: "Accept invitation" },
  "security.email_verification": { eyebrow: "ACCOUNT SECURITY", action: "Verify email" },
  "security.password_reset": { eyebrow: "ACCOUNT SECURITY", action: "Reset password" },
  "security.password_changed": { eyebrow: "ACCOUNT SECURITY", action: "Review your account" },
  "security.admin_login": { eyebrow: "SECURITY ALERT", action: "Review your account" },
  "account.created": { eyebrow: "WELCOME TO LIZZOR", action: "Open your account" },
  "account.guest_order_claimed": { eyebrow: "ACCOUNT UPDATE", action: "View your order" },
  "account.updates": { eyebrow: "ACCOUNT UPDATE", action: "Open Lizzor" },
  "support.ticket_created": { eyebrow: "SUPPORT CONFIRMATION", action: "View your request" },
  "admin.order_created": { eyebrow: "ADMIN ALERT", action: "Review order" },
  "admin.payment_failed": { eyebrow: "ADMIN ALERT", action: "Review payment" },
  "admin.support_ticket_created": { eyebrow: "ADMIN ALERT", action: "Review support request" },
  "system.test_email": { eyebrow: "EMAIL TEST", action: "Open Lizzor admin" },
};

export function renderNotificationEmail(input: {
  eventType: NotificationEventType;
  subject: string;
  message: string;
  actionUrl?: string;
  metadata?: Record<string, unknown> | null;
}) {
  const siteUrl = env.APP_ORIGIN ?? "http://localhost:5000";
  const style = presentation[input.eventType];
  const detailRows = [
    ["Order", input.metadata?.orderNumber],
    ["Tracking", input.metadata?.trackingNumber],
    ["Support request", input.metadata?.ticketNumber],
  ].filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number");
  const details = detailRows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;background:#f3f6f4;border-radius:8px">${detailRows.map(([label, value]) => `<tr><td style="padding:10px 14px;color:#68756e;font-size:12px">${label}</td><td align="right" style="padding:10px 14px;color:#18251f;font-size:13px;font-weight:700">${escapeHtml(String(value))}</td></tr>`).join("")}</table>`
    : "";
  const action = input.actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;background:#b8f500;color:#101713;padding:14px 22px;text-decoration:none;font-weight:800;border-radius:6px">${escapeHtml(style.action)}</a></p>`
    : "";
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media(max-width:620px){.card{padding:24px!important}.title{font-size:25px!important}}</style></head><body style="margin:0;background:#eef1ef;color:#18251f;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(input.message)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:10px;overflow:hidden"><tr><td style="height:7px;background:#b8f500"></td></tr><tr><td class="card" style="padding:34px"><div style="font-size:26px;font-weight:900;letter-spacing:-1.2px;color:#101713">Lizzor</div><div style="margin-top:4px;color:#68756e;font-size:12px">Wholesale. Anytime. Everywhere.</div><div style="margin-top:32px;color:#739900;font-size:11px;font-weight:800;letter-spacing:1.4px">${style.eyebrow}</div><h1 class="title" style="margin:8px 0 12px;font-size:29px;line-height:1.18;letter-spacing:-.5px">${escapeHtml(input.subject)}</h1><p style="margin:0;color:#46534c;font-size:15px;line-height:1.65">${escapeHtml(input.message)}</p>${details}${action}<p style="margin:34px 0 0;border-top:1px solid #e5e9e6;padding-top:18px;color:#7b8780;font-size:11px;line-height:1.5">This automated transactional message was sent by Lizzor.<br><a href="${escapeHtml(siteUrl)}" style="color:#587500">lizzor.com</a></p></td></tr></table></td></tr></table></body></html>`;
  const text = `${input.subject}\n\n${input.message}${detailRows.length ? `\n\n${detailRows.map(([label, value]) => `${label}: ${value}`).join("\n")}` : ""}${input.actionUrl ? `\n\n${style.action}: ${input.actionUrl}` : ""}\n\nLizzor — Wholesale. Anytime. Everywhere.\n${siteUrl}`;
  return { subject: input.subject, text, html };
}