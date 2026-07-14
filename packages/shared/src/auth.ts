import { z } from "zod";

export const sessionScopeSchema = z.enum([
  "wallet:read",
  "payment:prepare",
  "payment:read",
  "payment:review",
  "session:manage",
]);

export type SessionScope = z.infer<typeof sessionScopeSchema>;

export const sessionEnvironmentSchema = z.enum(["staging", "production"]);
export type SessionEnvironment = z.infer<typeof sessionEnvironmentSchema>;

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/i, "Expected an EVM address");
const isoDateSchema = z.string().datetime({ offset: true });

export const sessionContextSchema = z.object({
  sessionId: z.string().trim().min(1).max(160),
  tenantId: z.string().trim().min(1).max(160),
  ownerAddress: addressSchema,
  accountAddress: addressSchema,
  homeChainId: z.number().int().positive(),
  audience: z.string().url(),
  environment: sessionEnvironmentSchema,
  scopes: z.array(sessionScopeSchema).min(1),
  authEpoch: z.number().int().nonnegative(),
  issuedAt: isoDateSchema,
  expiresAt: isoDateSchema,
});

export type SessionContextInput = Omit<z.input<typeof sessionContextSchema>, "scopes"> & {
  scopes: readonly SessionScope[];
};

export interface SessionContext {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly ownerAddress: string;
  readonly accountAddress: string;
  readonly homeChainId: number;
  readonly audience: string;
  readonly environment: SessionEnvironment;
  readonly scopes: readonly SessionScope[];
  readonly authEpoch: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export class AgentPayAuthError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AgentPayAuthError";
    this.code = code;
  }
}

export function createSessionContext(input: SessionContextInput): SessionContext {
  const parsed = sessionContextSchema.parse({ ...input, scopes: [...input.scopes] });
  const issuedAt = new Date(parsed.issuedAt).getTime();
  const expiresAt = new Date(parsed.expiresAt).getTime();

  if (!parsed.audience.startsWith("https://")) {
    throw new AgentPayAuthError("AUTH_AUDIENCE_INVALID", "Consumer session audience must use HTTPS.");
  }

  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new AgentPayAuthError("AUTH_CONTEXT_INVALID", "Session expiry must be after its issue time.");
  }

  const scopes = [...new Set(parsed.scopes)].sort() as SessionScope[];
  return Object.freeze({
    ...parsed,
    ownerAddress: parsed.ownerAddress.toLowerCase(),
    accountAddress: parsed.accountAddress.toLowerCase(),
    scopes: Object.freeze(scopes),
  });
}

export function requireSessionContext(context: SessionContext | undefined | null): SessionContext {
  if (!context) {
    throw new AgentPayAuthError("AUTH_CONTEXT_REQUIRED", "A trusted consumer session is required.");
  }

  return context;
}

export function requireSessionScope(context: SessionContext, scope: SessionScope): SessionContext {
  const trusted = requireSessionContext(context);
  if (!trusted.scopes.includes(scope)) {
    throw new AgentPayAuthError("AUTH_SCOPE_REQUIRED", `The consumer session lacks ${scope} scope.`);
  }

  return trusted;
}

export function assertNoCallerAuthority(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return;
  }

  const forbidden = ["tenantId", "ownerAddress", "accountAddress"];
  const supplied = forbidden.find((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (supplied) {
    throw new AgentPayAuthError(
      "CALLER_AUTHORITY_FORBIDDEN",
      `${supplied} is derived from the authenticated consumer session and cannot be supplied by a caller.`,
    );
  }
}
