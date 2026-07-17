import { createProductionOnboardingRuntime } from "./runtime.ts";
import { startProductionOnboardingServer } from "./server.ts";

const runtime = await createProductionOnboardingRuntime(process.env);
const server = await startProductionOnboardingServer(runtime.dependencies, {
  port: runtime.config.port,
  hostname: "127.0.0.1",
});

console.log(`AgentPay production onboarding listening at ${server.url}`);
