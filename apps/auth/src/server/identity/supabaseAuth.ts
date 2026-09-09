/**
 * Supabase Auth provider for the personal deployment.
 *
 * Drop-in replacement for `../cognito/cognitoAuth.ts`, exporting the same six
 * functions with the same signatures, because those six are the entire identity
 * dependency of this service. The rest of the platform never learns which
 * provider issued a token: it reads `sub` and `email` and nothing else.
 *
 * Errors are deliberately raised through `createCognitoTypedError`, reusing the
 * existing typed-error shape rather than inventing one. Four route modules
 * already classify failures with `getNormalizedCognitoErrorType` and
 * `isCognitoInvalidEmailError`, so emitting the same `cognitoType` strings keeps
 * every one of those branches working untouched. Naming stays imperfect —
 * `cognitoType` on a Supabase error — but a rename would touch four route files
 * and `cognitoErrors.ts` for no behavior change, and every line this branch does
 * not diverge from upstream is one less merge conflict later.
 *
 * Endpoint reference: https://supabase.com/docs/reference/api/auth
 */
import {
  createCognitoTypedError,
  type CognitoOperation,
} from "../cognito/cognitoErrors.js";
import { log, maskEmail } from "../logger.js";

export type TokenResult = Readonly<{
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}>;

type RefreshResult = Readonly<{
  idToken: string;
  accessToken: string;
  expiresIn: number;
}>;

type InitiateAuthResult = Readonly<{
  session: string;
}>;

type SupabaseErrorBody = Readonly<{
  error_code?: unknown;
  error?: unknown;
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  error_description?: unknown;
}>;

function getSupabaseUrl(): string {
  const value = process.env.SUPABASE_URL ?? "";
  if (value === "") {
    throw new Error("SUPABASE_URL is not configured");
  }

  return value.replace(/\/+$/, "");
}

function getSupabaseAnonKey(): string {
  const value = process.env.SUPABASE_ANON_KEY ?? "";
  if (value === "") {
    throw new Error("SUPABASE_ANON_KEY is not configured");
  }

  return value;
}

function readStringField(body: SupabaseErrorBody, field: keyof SupabaseErrorBody): string {
  const value = body[field];
  return typeof value === "string" ? value : "";
}

/**
 * Maps a Supabase auth failure onto the `cognitoType` vocabulary the routes
 * already branch on.
 *
 * The left-hand side is Supabase's stable `error_code`; the right-hand side is
 * only ever read back through `getNormalizedCognitoErrorType`, which lowercases
 * and substring-matches, so these names are an internal contract between this
 * file and the route modules rather than anything sent to a client.
 */
function toProviderErrorType(errorCode: string, message: string, status: number): string {
  const normalizedCode = errorCode.toLowerCase();
  const normalizedMessage = message.toLowerCase();

  if (normalizedCode === "otp_expired" || normalizedMessage.includes("expired")) {
    return "ExpiredCodeException";
  }

  if (
    normalizedCode === "otp_disabled"
    || normalizedCode === "invalid_credentials"
    || normalizedCode === "bad_jwt"
    || normalizedMessage.includes("token has expired or is invalid")
    || normalizedMessage.includes("invalid login credentials")
  ) {
    return "CodeMismatchException";
  }

  if (
    normalizedCode.startsWith("over_")
    || normalizedCode === "rate_limit_exceeded"
    || status === 429
  ) {
    return "TooManyRequestsException";
  }

  if (
    normalizedCode === "email_address_invalid"
    || normalizedCode === "validation_failed"
    || normalizedMessage.includes("unable to validate email address")
  ) {
    return "InvalidParameterException";
  }

  if (
    normalizedCode === "refresh_token_not_found"
    || normalizedCode === "refresh_token_already_used"
    || normalizedCode === "session_not_found"
    || normalizedCode === "invalid_grant"
    || normalizedMessage.includes("refresh token not found")
    || normalizedMessage.includes("already used")
  ) {
    return "NotAuthorizedException";
  }

  if (normalizedCode === "user_not_found" || normalizedMessage.includes("user not found")) {
    return "UserNotFoundException";
  }

  return errorCode === "" ? `SupabaseHttp${status}` : errorCode;
}

/**
 * `isCognitoInvalidEmailError` matches this exact message, so a malformed
 * address has to arrive spelled the way that check expects.
 */
function toProviderErrorMessage(errorType: string, rawMessage: string): string {
  if (errorType === "InvalidParameterException") {
    return "Invalid email address format.";
  }

  return rawMessage === "" ? "Supabase Auth request failed" : rawMessage;
}

async function supabaseFetch(
  operation: CognitoOperation,
  path: string,
  body: Record<string, unknown> | null,
  bearerToken: string | null,
): Promise<Record<string, unknown>> {
  const anonKey = getSupabaseAnonKey();
  const response = await fetch(`${getSupabaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${bearerToken ?? anonKey}`,
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });

  const rawText = await response.text();
  const parsed: unknown = rawText === "" ? {} : JSON.parse(rawText);
  const parsedBody = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as Record<string, unknown>;

  if (response.ok) {
    return parsedBody;
  }

  const errorBody = parsedBody as SupabaseErrorBody;
  const errorCode = readStringField(errorBody, "error_code") !== ""
    ? readStringField(errorBody, "error_code")
    : readStringField(errorBody, "error");
  const rawMessage = [
    readStringField(errorBody, "msg"),
    readStringField(errorBody, "message"),
    readStringField(errorBody, "error_description"),
  ].find((candidate) => candidate !== "") ?? "";
  const errorType = toProviderErrorType(errorCode, rawMessage, response.status);

  throw createCognitoTypedError({
    operation,
    providerStatusCode: response.status,
    cognitoType: errorType,
    reasonCode: errorCode === "" ? null : errorCode,
    message: toProviderErrorMessage(errorType, rawMessage),
  });
}

function extractRequiredStringField(
  value: unknown,
  fieldName: string,
  context: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} did not return ${fieldName}`);
  }

  return value;
}

/**
 * Supabase issues one JWT, `access_token`, carrying `sub` and `email`. Cognito
 * issues a separate ID token, and the platform asks for `idToken`. The same
 * value fills both: what every consumer actually reads is `sub` and `email`, and
 * both verifiers in this repository are pointed at this token.
 */
function extractTokenResult(
  result: Record<string, unknown>,
  context: string,
): TokenResult {
  const accessToken = extractRequiredStringField(result.access_token, "access_token", context);
  const expiresIn = typeof result.expires_in === "number" ? result.expires_in : 3600;

  return {
    idToken: accessToken,
    accessToken,
    refreshToken: extractRequiredStringField(result.refresh_token, "refresh_token", context),
    expiresIn,
  };
}

/**
 * Starts an email OTP sign-in, creating the account on first use.
 *
 * Supabase verifies with `(email, token)` and needs no server-side challenge
 * handle, but the caller persists whatever comes back here and hands it to
 * `verifyEmailOtp`, and both the rate limiter and the verify-attempt ledger key
 * on it. So this returns a fresh opaque correlation id instead. Single-use
 * enforcement does not weaken: Supabase invalidates the emailed token itself,
 * and `otpVerifyAttempts` bounds replay locally.
 */
export const initiateEmailOtp = async (email: string): Promise<InitiateAuthResult> => {
  await supabaseFetch("InitiateAuth", "/auth/v1/otp", {
    email,
    create_user: true,
  }, null);

  log({ domain: "auth", action: "send_code", maskedEmail: maskEmail(email) });

  return { session: crypto.randomUUID() };
};

export const verifyEmailOtp = async (
  email: string,
  code: string,
  _session: string,
): Promise<TokenResult> => {
  const result = await supabaseFetch("RespondToAuthChallenge", "/auth/v1/verify", {
    type: "email",
    email,
    token: code,
  }, null);

  log({ domain: "auth", action: "verify_code", maskedEmail: maskEmail(email) });

  return extractTokenResult(result, "Supabase verify");
};

export const signInWithPassword = async (
  email: string,
  password: string,
): Promise<TokenResult> => {
  const result = await supabaseFetch(
    "InitiateAuth",
    "/auth/v1/token?grant_type=password",
    { email, password },
    null,
  );

  log({ domain: "auth", action: "sign_in_password", maskedEmail: maskEmail(email) });

  return extractTokenResult(result, "Supabase password grant");
};

export const refreshTokens = async (refreshToken: string): Promise<RefreshResult> => {
  const result = await supabaseFetch(
    "InitiateAuth",
    "/auth/v1/token?grant_type=refresh_token",
    { refresh_token: refreshToken },
    null,
  );

  log({ domain: "auth", action: "refresh_token" });

  const accessToken = extractRequiredStringField(
    result.access_token,
    "access_token",
    "Supabase refresh grant",
  );

  return {
    idToken: accessToken,
    accessToken,
    expiresIn: typeof result.expires_in === "number" ? result.expires_in : 3600,
  };
};

export function isTerminalRefreshFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("cognitoType" in error)) {
    return false;
  }

  const providerType = typeof error.cognitoType === "string"
    ? error.cognitoType.toLowerCase()
    : "";
  return providerType.includes("notauthorizedexception");
}

/**
 * Ends the session behind a refresh token.
 *
 * Supabase revokes through `/auth/v1/logout`, which authenticates with an access
 * token rather than a refresh token, so the refresh token is spent for one
 * first. A refresh that fails terminally means the session is already gone,
 * which is the outcome this function exists to produce, so it returns quietly
 * instead of failing a sign-out the user already asked for.
 */
export const revokeToken = async (refreshToken: string): Promise<void> => {
  let accessToken: string;
  try {
    accessToken = (await refreshTokens(refreshToken)).accessToken;
  } catch (error) {
    if (isTerminalRefreshFailure(error)) {
      // Already revoked is the outcome this function exists to produce, so it
      // logs as an ordinary revocation rather than widening the action union.
      log({ domain: "auth", action: "revoke_token" });
      return;
    }

    throw error;
  }

  await supabaseFetch("RevokeToken", "/auth/v1/logout", null, accessToken);

  log({ domain: "auth", action: "revoke_token" });
};
