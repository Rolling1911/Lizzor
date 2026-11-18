export type WorkerState = "not_started" | "running" | "idle" | "standby" | "failed" | "disabled";
export type ApplicationStartupState = "starting" | "ready" | "failed";

type WorkerStatus = {
  state: WorkerState;
  updatedAt: string;
  lastSuccessAt?: string;
  lastError?: string;
};

let paymentRecoveryWorker: WorkerStatus = { state: "not_started", updatedAt: new Date().toISOString() };
let applicationStartup: {
  state: ApplicationStartupState;
  startedAt: string;
  readyAt?: string;
  lastError?: string;
} = {
  // createApp() is also used directly by integration tests. The executable
  // entrypoint explicitly transitions this to "starting" before binding.
  state: "ready",
  startedAt: new Date().toISOString(),
  readyAt: new Date().toISOString(),
};

export function beginApplicationStartup(): void {
  applicationStartup = {
    state: "starting",
    startedAt: new Date().toISOString(),
  };
}

export function markApplicationReady(): void {
  applicationStartup = {
    ...applicationStartup,
    state: "ready",
    readyAt: new Date().toISOString(),
    lastError: undefined,
  };
}

export function markApplicationStartupFailed(error: unknown): void {
  applicationStartup = {
    ...applicationStartup,
    state: "failed",
    lastError: error instanceof Error ? error.message.slice(0, 300) : "Unknown initialization error",
  };
}

export function getApplicationStartupStatus() {
  return { ...applicationStartup };
}

export function setPaymentRecoveryWorkerStatus(state: WorkerState, error?: unknown): void {
  const now = new Date().toISOString();
  paymentRecoveryWorker = {
    state,
    updatedAt: now,
    ...(state === "idle" ? { lastSuccessAt: now } : { lastSuccessAt: paymentRecoveryWorker.lastSuccessAt }),
    ...(error ? { lastError: error instanceof Error ? error.message.slice(0, 300) : "Unknown worker error" } : { lastError: state === "failed" ? paymentRecoveryWorker.lastError : undefined }),
  };
}

export function getPaymentRecoveryWorkerStatus(): WorkerStatus {
  return { ...paymentRecoveryWorker };
}