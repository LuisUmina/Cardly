import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { isRejectedIdentityToken, verifyIdentityToken } from "./identity/tokenVerifier.js";

const SESSION_COOKIE_MAX_AGE_SECONDS = 3_024_000;

type SessionTokenValidationResult =
  | Readonly<{ status: "valid" }>
  | Readonly<{ status: "invalid"; reason: string }>
  | Readonly<{ status: "error"; reason: string }>;

type VerifiedSessionTokenPayload = Readonly<{
  sub: string;
  email?: unknown;
}>;

export type SessionUserIdentity = Readonly<{
  userId: string;
  email: string;
}>;

function getCookieDomain(): string | undefined {
  const domain = process.env.COOKIE_DOMAIN ?? "";
  return domain === "" ? undefined : domain;
}

function getCookieOptions(): Readonly<{
  path: string;
  secure: boolean;
  sameSite: "Lax";
  domain: string | undefined;
}> {
  return {
    path: "/",
    secure: true,
    sameSite: "Lax",
    domain: getCookieDomain(),
  };
}

export async function validateSessionToken(sessionToken: string): Promise<SessionTokenValidationResult> {
  try {
    await verifyIdentityToken(sessionToken);
    return { status: "valid" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The split that matters is "this token is bad" versus "we could not reach
    // the keys to tell", because only the second is worth retrying and only the
    // first should log the visitor out.
    if (isRejectedIdentityToken(error)) {
      return { status: "invalid", reason };
    }

    return { status: "error", reason };
  }
}

/**
 * Verifies an identity token issued for this app and returns the stable user
 * identity so the auth service can create first-party agent API keys.
 */
export function extractVerifiedSessionIdentity(payload: VerifiedSessionTokenPayload): SessionUserIdentity {
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email === "") {
    throw new Error("Identity token is missing email claim");
  }

  return {
    userId: payload.sub,
    email,
  };
}

export async function verifySessionTokenIdentity(sessionToken: string): Promise<SessionUserIdentity> {
  const payload = await verifyIdentityToken(sessionToken);
  return extractVerifiedSessionIdentity(payload as VerifiedSessionTokenPayload);
}

export function setBrowserSessionCookies(
  context: Context,
  sessionToken: string,
  refreshToken: string,
): void {
  const cookieOptions = getCookieOptions();

  setCookie(context, "session", sessionToken, {
    ...cookieOptions,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
  });

  setCookie(context, "refresh", refreshToken, {
    ...cookieOptions,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    httpOnly: true,
  });

  setCookie(context, "logged_in", "1", {
    ...cookieOptions,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    httpOnly: false,
  });
}

export function clearBrowserSessionCookies(context: Context): void {
  const cookieOptions = getCookieOptions();

  deleteCookie(context, "session", cookieOptions);
  deleteCookie(context, "refresh", cookieOptions);
  deleteCookie(context, "logged_in", cookieOptions);
}
