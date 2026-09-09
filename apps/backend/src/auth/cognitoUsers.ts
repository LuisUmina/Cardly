/**
 * Identity-provider account deletion.
 *
 * The file keeps its name and its exported `deleteCognitoUser` because account
 * deletion injects that function by name through
 * `AccountDeletionDependencies`; only the provider behind it changed, from
 * Cognito's `AdminDeleteUser` to Supabase's admin users endpoint.
 *
 * This is the one path that needs the service-role key. That key bypasses
 * row-level security and can delete any account, so it stays out of the auth
 * service, which never deletes users, and is read lazily here rather than at
 * module load, so a deployment that never deletes an account never needs it set.
 */
import { HttpError } from "../shared/errors";

function getSupabaseUrl(): string {
  const value = process.env.SUPABASE_URL?.trim() ?? "";
  if (value === "") {
    throw new Error("SUPABASE_URL is required for identity user deletion");
  }

  return value.replace(/\/+$/, "");
}

function getSupabaseServiceRoleKey(): string {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (value === "") {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for identity user deletion");
  }

  return value;
}

export async function deleteCognitoUser(cognitoUsername: string): Promise<void> {
  const userId = cognitoUsername.trim();
  if (userId === "") {
    throw new HttpError(
      500,
      "Account deletion could not resolve the identity provider user for this user.",
      "ACCOUNT_DELETE_IDENTITY_DELETE_FAILED",
    );
  }

  const serviceRoleKey = getSupabaseServiceRoleKey();
  const response = await fetch(
    `${getSupabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  // An account that is already gone is the state this function exists to reach,
  // so a 404 is success. Deletion is also retried after partial failures, and
  // treating it as an error would strand every retry.
  if (response.ok || response.status === 404) {
    return;
  }

  const body = await response.text();
  throw new Error(
    `Supabase admin user deletion failed with HTTP ${response.status}: ${body}`,
  );
}
