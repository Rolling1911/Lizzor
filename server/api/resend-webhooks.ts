import { Router } from "express";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error-handler.js";
import { processResendWebhook, verifyResendWebhook } from "../notifications/resend-webhooks.js";

export const resendWebhooksRouter = Router();

resendWebhooksRouter.post("/webhooks/resend", async (request, response) => {
  const id = request.get("svix-id");
  const timestamp = request.get("svix-timestamp");
  const signature = request.get("svix-signature");
  if (!env.RESEND_WEBHOOK_SECRET || !id || !timestamp || !signature || !Buffer.isBuffer(request.body)) {
    throw new AppError(400, "INVALID_RESEND_SIGNATURE", "The webhook signature is invalid.");
  }
  let event;
  try {
    event = verifyResendWebhook(request.body, { id, timestamp, signature }, env.RESEND_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, "INVALID_RESEND_SIGNATURE", "The webhook signature is invalid.");
  }
  response.json({ data: await processResendWebhook(id, event) });
});