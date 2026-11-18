export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export interface ApiResponse<T> {
  data: T;
  meta?: {
    requestId?: string;
  };
}

export interface HealthResponse {
  status: "ok";
  service: "lizzor-api";
  version: string;
  timestamp: string;
}

export interface ReadinessResponse {
  status: "ready" | "degraded";
  checks: {
    api: "ok";
    startup: "starting" | "ready" | "failed";
    database: "connected" | "not_configured" | "unavailable";
    paymentProvider: "configured" | "not_configured";
    paymentFrontend: "configured" | "not_configured";
    paymentWebhook: "configured" | "not_configured";
    notificationProvider: "development_only" | "not_configured" | "configured";
    mediaStorage: "development_only" | "not_configured" | "configured" | "unavailable";
    sessionSecret: "configured" | "not_configured";
    recoveryWorker: "not_started" | "running" | "idle" | "standby" | "failed" | "disabled";
    tooniesProcurementConfigured: "enabled" | "disabled";
    tooniesDatabaseAttestation: "pass" | "fail" | "not_checked";
    tooniesProcurementEffective: "enabled" | "disabled";
  };
}