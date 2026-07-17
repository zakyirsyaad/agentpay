import { createProductionSetupWorkerRuntime } from "./runtime.ts";

export async function startProductionSetupWorker(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: Readonly<{
    signal?: AbortSignal;
    log?: (message: string) => void;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  }> = {},
): Promise<void> {
  const runtime = await createProductionSetupWorkerRuntime(env);
  const log = options.log ?? ((message: string) => console.info(message));
  const wait = options.wait ?? waitFor;
  log(`AgentPay production setup worker ready (${runtime.config.workerId}, mode ${runtime.config.mode}).`);
  while (!options.signal?.aborted) {
    try {
      const result = await runtime.worker.processNext(new Date().toISOString());
      if (result.status !== "IDLE" && result.status !== "PENDING") {
        log(`Setup job ${result.jobId ?? "unknown"} entered ${result.status}.`);
      }
      if (result.status !== "IDLE" && result.status !== "PENDING") continue;
    } catch {
      log("Setup worker iteration failed; the fenced job remains recoverable.");
    }
    await wait(runtime.config.pollIntervalMs, options.signal);
  }
}

async function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  startProductionSetupWorker(process.env, { signal: controller.signal }).catch(() => {
    console.error("AgentPay production setup worker failed readiness checks.");
    process.exitCode = 1;
  });
}
