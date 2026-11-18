import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logger, withLogContext } from "../lib/logger.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const suppliedRequestId = req.header("x-request-id");
  req.requestId = suppliedRequestId && /^[A-Za-z0-9._-]{1,128}$/.test(suppliedRequestId) ? suppliedRequestId : randomUUID();
  res.setHeader("x-request-id", req.requestId);
  const startedAt = Date.now();

  res.on("finish", () => {
    logger.info("request completed", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  withLogContext({ requestId: req.requestId }, next);
}