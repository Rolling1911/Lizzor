import type { ErrorRequestHandler, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.path} was not found`,
      requestId: req.requestId,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next): void => {
  const requestId = req.requestId;

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "The request could not be validated.",
        details: error.flatten(),
        requestId,
      },
    });
    return;
  }

  const appError = error instanceof AppError ? error : undefined;
  const statusCode = appError?.statusCode ?? 500;
  logger.error("request failed", {
    requestId,
    error: appError?.code ?? (error instanceof Error ? error.name : "Unknown error"),
  });

  res.status(statusCode).json({
    error: {
      code: appError?.code ?? "INTERNAL_ERROR",
      message: appError?.message ?? "An unexpected error occurred.",
      ...(appError?.details ? { details: appError.details } : {}),
      requestId,
    },
  });
};