import {
  isRejectedIdentityToken,
  runWithIdentityJwksAbortSignal,
  verifyIdentityToken,
} from "./identityTokenVerifier";
import { authenticateAgentApiKey } from "../agent/apiKeys";
import { getAuthConfig } from "./config";
import { HttpError } from "../shared/errors";
import { authenticateGuestSession } from "../guestAuth/session/index";
import type { GuestSessionPlatform } from "../guestAuth/types";
import { loadCognitoIdentityMapping } from "./userIdentities";

export type AuthTransport = "none" | "bearer" | "session" | "api_key" | "guest";

export const authVerificationTemporarilyUnavailableCode = "AUTH_VERIFICATION_TEMPORARILY_UNAVAILABLE";
export const authVerificationRetryAfterSeconds = 10;

export type AuthResult = Readonly<{
  userId: string;
  email: string | null;
  cognitoUsername: string | null;
  subjectUserId: string;
  transport: AuthTransport;
  connectionId: string | null;
  selectedWorkspaceId: string | null;
  guestSessionId: string | null;
  guestPlatform: GuestSessionPlatform | null;
}>;

export type AuthRequest = Readonly<{
  authorizationHeader: string | undefined;
  sessionToken: string | undefined;
}>;

type VerifiedIdTokenPayload = Readonly<{
  sub: string;
  email?: unknown;
}>;

export type AuthenticatedUserIdentity = Readonly<{
  userId: string;
  email: string;
  cognitoUsername: string | null;
}>;

export function isTerminalJwtAuthFailure(error: unknown): boolean {
  return isRejectedIdentityToken(error);
}

/**
 * A JWKS fetch that timed out says nothing about the token, so it must not sign
 * the caller out. It maps to the same 503 the Cognito wiring used for a JWKS
 * cooldown, which tells clients to retry rather than re-authenticate.
 */
function isTransientJwtVerificationFailure(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ERR_JWKS_TIMEOUT";
}

export function createJwtAuthBoundaryError(error: unknown): AuthError | HttpError | null {
  if (isTerminalJwtAuthFailure(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return new AuthError(401, `Invalid token: ${message}`);
  }

  if (isTransientJwtVerificationFailure(error)) {
    return new HttpError(
      503,
      "Authentication verification is temporarily unavailable. Retry shortly.",
      authVerificationTemporarilyUnavailableCode,
    );
  }

  return null;
}

type ParsedAuthorizationHeader =
  | Readonly<{ scheme: "none" }>
  | Readonly<{ scheme: "bearer"; token: string }>
  | Readonly<{ scheme: "guest"; token: string }>
  | Readonly<{ scheme: "api_key"; token: string }>;

function parseAuthorizationHeader(authorizationHeader: string | undefined): ParsedAuthorizationHeader {
  if (authorizationHeader === undefined || authorizationHeader === "") {
    return { scheme: "none" };
  }

  if (authorizationHeader.startsWith("Bearer ")) {
    const token = authorizationHeader.slice(7).trim();
    if (token === "") {
      throw new AuthError(401, "Authorization header must include a token");
    }

    return { scheme: "bearer", token };
  }

  if (authorizationHeader.startsWith("ApiKey ")) {
    const token = authorizationHeader.slice(7).trim();
    if (token === "") {
      throw new AuthError(401, "Authorization header must include an API key");
    }

    return { scheme: "api_key", token };
  }

  if (authorizationHeader.startsWith("Guest ")) {
    const token = authorizationHeader.slice(6).trim();
    if (token === "") {
      throw new AuthError(401, "Authorization header must include a guest token");
    }

    return { scheme: "guest", token };
  }

  throw new AuthError(401, "Authorization header must use Bearer, Guest, or ApiKey scheme");
}

/**
 * `cognitoUsername` keeps its name but now carries the provider's user id.
 *
 * It has exactly one consumer, `deleteCognitoUser` in account deletion, which
 * needs whatever handle identifies the account at the identity provider. For
 * Cognito that was the `cognito:username` claim; for Supabase it is `sub`, which
 * is what the admin delete endpoint addresses. Renaming the field would reach
 * across `accountDeletion.ts`, the auth result type and every construction site
 * for no behavior change.
 */
export function extractVerifiedIdTokenIdentity(payload: VerifiedIdTokenPayload): AuthenticatedUserIdentity {
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email === "") {
    throw new Error("Identity token is missing email claim");
  }

  return {
    userId: payload.sub,
    email,
    cognitoUsername: payload.sub,
  };
}

async function verifyIdTokenPayload(token: string): Promise<AuthenticatedUserIdentity> {
  try {
    const payload = await verifyIdentityToken(token);
    return extractVerifiedIdTokenIdentity(payload as VerifiedIdTokenPayload);
  } catch (err) {
    const boundaryError = createJwtAuthBoundaryError(err);
    if (boundaryError !== null) {
      throw boundaryError;
    }

    throw err;
  }
}

async function verifyIdToken(token: string): Promise<AuthenticatedUserIdentity> {
  return verifyIdTokenPayload(token);
}

async function verifyIdTokenForDirectRequest(
  token: string,
  abortSignal: AbortSignal,
): Promise<AuthenticatedUserIdentity> {
  return runWithIdentityJwksAbortSignal(
    abortSignal,
    () => verifyIdTokenPayload(token),
  );
}

type AuthenticationOperationRunner = <Result>(
  operation: () => Promise<Result>,
) => Promise<Result>;

export type AuthenticateRequestDependencies = Readonly<{
  authenticateAgentApiKeyFn: typeof authenticateAgentApiKey;
  authenticateGuestSessionFn: typeof authenticateGuestSession;
  loadCognitoIdentityMappingFn: typeof loadCognitoIdentityMapping;
  verifyIdTokenFn: (token: string) => Promise<AuthenticatedUserIdentity>;
}>;

function runAuthenticationOperation<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  return operation();
}

function runAuthenticationOperationWithAbortSignal<Result>(
  abortSignal: AbortSignal,
  operation: () => Promise<Result>,
): Promise<Result> {
  abortSignal.throwIfAborted();
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const settleResult = (value: Result): void => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener("abort", handleAbort);
      resolve(value);
    };
    const settleError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener("abort", handleAbort);
      reject(error);
    };
    const handleAbort = (): void => {
      settleError(abortSignal.reason);
    };

    abortSignal.addEventListener("abort", handleAbort, { once: true });
    if (abortSignal.aborted) {
      handleAbort();
      return;
    }

    let operationPromise: Promise<Result>;
    try {
      operationPromise = operation();
    } catch (error) {
      settleError(error);
      return;
    }
    operationPromise.then(
      settleResult,
      settleError,
    );
  });
}

function createAbortAwareAuthenticationOperationRunner(
  abortSignal: AbortSignal,
): AuthenticationOperationRunner {
  return <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> =>
    runAuthenticationOperationWithAbortSignal(abortSignal, operation);
}

async function authenticateRequestWithDependencies(
  request: AuthRequest,
  runOperation: AuthenticationOperationRunner,
  dependencies: AuthenticateRequestDependencies,
): Promise<AuthResult> {
  const authConfig = getAuthConfig();

  if (authConfig.mode === "none") {
    return {
      userId: "local",
      email: null,
      cognitoUsername: null,
      subjectUserId: "local",
      transport: "none",
      connectionId: null,
      selectedWorkspaceId: null,
      guestSessionId: null,
      guestPlatform: null,
    };
  }

  const parsedAuthorization = parseAuthorizationHeader(request.authorizationHeader);
  if (parsedAuthorization.scheme === "api_key") {
    const auth = await runOperation(
      () => dependencies.authenticateAgentApiKeyFn(parsedAuthorization.token),
    );
    return {
      userId: auth.userId,
      email: null,
      cognitoUsername: null,
      subjectUserId: auth.userId,
      transport: "api_key",
      connectionId: auth.connectionId,
      selectedWorkspaceId: auth.selectedWorkspaceId,
      guestSessionId: null,
      guestPlatform: null,
    };
  }

  if (parsedAuthorization.scheme === "bearer") {
    const identity = await runOperation(
      () => dependencies.verifyIdTokenFn(parsedAuthorization.token),
    );
    const mapping = await runOperation(
      () => dependencies.loadCognitoIdentityMappingFn(identity.userId),
    );
    return {
      ...identity,
      userId: mapping?.userId ?? identity.userId,
      subjectUserId: identity.userId,
      transport: "bearer",
      connectionId: null,
      selectedWorkspaceId: null,
      guestSessionId: null,
      guestPlatform: null,
    };
  }

  if (parsedAuthorization.scheme === "guest") {
    const guestSession = await runOperation(
      () => dependencies.authenticateGuestSessionFn(parsedAuthorization.token),
    );
    return {
      userId: guestSession.userId,
      email: null,
      cognitoUsername: null,
      subjectUserId: guestSession.userId,
      transport: "guest",
      connectionId: null,
      selectedWorkspaceId: null,
      guestSessionId: guestSession.sessionId,
      guestPlatform: guestSession.platform,
    };
  }

  const sessionToken = request.sessionToken;
  if (sessionToken !== undefined && sessionToken !== "") {
    const identity = await runOperation(
      () => dependencies.verifyIdTokenFn(sessionToken),
    );
    const mapping = await runOperation(
      () => dependencies.loadCognitoIdentityMappingFn(identity.userId),
    );
    return {
      ...identity,
      userId: mapping?.userId ?? identity.userId,
      subjectUserId: identity.userId,
      transport: "session",
      connectionId: null,
      selectedWorkspaceId: null,
      guestSessionId: null,
      guestPlatform: null,
    };
  }

  throw new AuthError(401, "Missing authentication token");
}

/**
 * Authenticates one request using the validated backend auth config rather
 * than raw env defaults. App startup must already have rejected missing or
 * unsafe auth configuration before any request reaches this function.
 */
export async function authenticateRequest(request: AuthRequest): Promise<AuthResult> {
  return authenticateRequestWithDependencies(
    request,
    runAuthenticationOperation,
    {
      authenticateAgentApiKeyFn: authenticateAgentApiKey,
      authenticateGuestSessionFn: authenticateGuestSession,
      loadCognitoIdentityMappingFn: loadCognitoIdentityMapping,
      verifyIdTokenFn: verifyIdToken,
    },
  );
}

export function authenticateRequestWithAbortSignalAndDependencies(
  request: AuthRequest,
  abortSignal: AbortSignal,
  dependencies: AuthenticateRequestDependencies,
): Promise<AuthResult> {
  abortSignal.throwIfAborted();
  return authenticateRequestWithDependencies(
    request,
    createAbortAwareAuthenticationOperationRunner(abortSignal),
    dependencies,
  );
}

export function authenticateRequestWithAbortSignal(
  request: AuthRequest,
  abortSignal: AbortSignal,
): Promise<AuthResult> {
  return authenticateRequestWithAbortSignalAndDependencies(
    request,
    abortSignal,
    {
      authenticateAgentApiKeyFn: authenticateAgentApiKey,
      authenticateGuestSessionFn: authenticateGuestSession,
      loadCognitoIdentityMappingFn: loadCognitoIdentityMapping,
      verifyIdTokenFn: (token) =>
        verifyIdTokenForDirectRequest(token, abortSignal),
    },
  );
}

export class AuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
