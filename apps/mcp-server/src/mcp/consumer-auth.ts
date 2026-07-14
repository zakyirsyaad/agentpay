import {
  AgentPayAuthError,
  type SessionContext,
  type SessionScope,
} from "@agentpay-ai/shared";

import { parseBearerToken } from "../auth/session.ts";

export type ConsumerRequestHeaders = Record<string, string | string[] | undefined> & {
  query?: string;
};

export interface ConsumerSessionAuthenticator {
  authenticate(credential: string, requiredScope?: SessionScope): Promise<SessionContext>;
}
export async function authenticateConsumerRequest(
  headers: ConsumerRequestHeaders,
  authenticator: ConsumerSessionAuthenticator,
  requiredScope?: SessionScope,
): Promise<SessionContext> {
  if (headers.query && /(?:^|[?&])(?:token|access_token|authorization)=/i.test(headers.query)) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_QUERY_FORBIDDEN", "Consumer credentials may not be sent in a URL.");
  }

  const authorization = headers.authorization ?? headers.Authorization;
  if (Array.isArray(authorization)) {
    throw new AgentPayAuthError("AUTH_CREDENTIAL_REQUIRED", "Bearer credential required.");
  }
  const credential = parseBearerToken(authorization);
  return authenticator.authenticate(credential, requiredScope);
}
