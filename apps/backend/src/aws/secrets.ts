import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface DatabaseCredentialsSecret {
  username: string;
  password: string;
}

const secretsClient = new SecretsManagerClient({});
let resolvedBackendCsrfSecret: string | undefined;
let resolvedBackendChatLiveAuthSecret: string | undefined;

/**
 * Reads a plaintext secret held directly in an environment variable.
 *
 * The reference AWS deployment keeps these in Secrets Manager and passes the ARN
 * down. A deployment hosted outside AWS has no Secrets Manager to read and no AWS
 * credentials to read it with, so it sets the value itself instead. The direct
 * variable is checked first for exactly that reason: reaching Secrets Manager at
 * all is what fails there, so the fallback has to come before the call, not after
 * it. The reference deployment sets only the ARN, so this returns `null` there and
 * nothing about its behavior changes.
 */
function readDirectSecretEnv(envName: string): string | null {
  const value = process.env[envName];
  if (value === undefined || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function createMissingSecretSourceError(envName: string, arnEnvName: string): Error {
  return new Error(
    `${envName} or ${arnEnvName} is required. Set ${envName} to the secret value when hosting outside AWS, or ${arnEnvName} to a Secrets Manager ARN.`,
  );
}

async function loadDatabaseCredentialsSecret(
  secretArn: string,
  abortSignal: AbortSignal | null,
): Promise<DatabaseCredentialsSecret> {
  abortSignal?.throwIfAborted();
  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = abortSignal === null
    ? await secretsClient.send(command)
    : await secretsClient.send(command, { abortSignal });
  abortSignal?.throwIfAborted();
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} does not contain SecretString`);
  }

  const value = JSON.parse(response.SecretString) as Partial<DatabaseCredentialsSecret>;
  if (typeof value.username !== "string" || value.username.trim() === "") {
    throw new Error(`Secret ${secretArn} does not contain a valid username`);
  }

  if (typeof value.password !== "string" || value.password.trim() === "") {
    throw new Error(`Secret ${secretArn} does not contain a valid password`);
  }

  return {
    username: value.username,
    password: value.password,
  };
}

export async function getDatabaseCredentialsSecret(secretArn: string): Promise<DatabaseCredentialsSecret> {
  return loadDatabaseCredentialsSecret(secretArn, null);
}

export async function getDatabaseCredentialsSecretWithAbortSignal(
  secretArn: string,
  abortSignal: AbortSignal,
): Promise<DatabaseCredentialsSecret> {
  return loadDatabaseCredentialsSecret(secretArn, abortSignal);
}

async function loadBackendCsrfSecret(
  secretArn: string | null,
  abortSignal: AbortSignal | null,
): Promise<string> {
  if (resolvedBackendCsrfSecret !== undefined) {
    return resolvedBackendCsrfSecret;
  }

  const directSecret = readDirectSecretEnv("BACKEND_CSRF_SECRET");
  if (directSecret !== null) {
    resolvedBackendCsrfSecret = directSecret;
    return resolvedBackendCsrfSecret;
  }

  if (secretArn === null) {
    throw createMissingSecretSourceError("BACKEND_CSRF_SECRET", "BACKEND_CSRF_SECRET_ARN");
  }

  abortSignal?.throwIfAborted();
  // CSRF signing key is immutable for the lifetime of the Lambda process,
  // so caching avoids a Secrets Manager read on every request.
  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = abortSignal === null
    ? await secretsClient.send(command)
    : await secretsClient.send(command, { abortSignal });
  abortSignal?.throwIfAborted();
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} does not contain SecretString`);
  }

  const value = response.SecretString.trim();
  if (value === "") {
    throw new Error(`Secret ${secretArn} must not be empty`);
  }

  resolvedBackendCsrfSecret = value;
  return resolvedBackendCsrfSecret;
}

export async function getBackendCsrfSecret(secretArn: string | null): Promise<string> {
  return loadBackendCsrfSecret(secretArn, null);
}

export async function getBackendCsrfSecretWithAbortSignal(
  secretArn: string | null,
  abortSignal: AbortSignal,
): Promise<string> {
  return loadBackendCsrfSecret(secretArn, abortSignal);
}

export async function getBackendChatLiveAuthSecret(secretArn: string | null): Promise<string> {
  if (resolvedBackendChatLiveAuthSecret !== undefined) {
    return resolvedBackendChatLiveAuthSecret;
  }

  const directSecret = readDirectSecretEnv("BACKEND_CHAT_LIVE_AUTH_SECRET");
  if (directSecret !== null) {
    resolvedBackendChatLiveAuthSecret = directSecret;
    return resolvedBackendChatLiveAuthSecret;
  }

  if (secretArn === null) {
    throw createMissingSecretSourceError(
      "BACKEND_CHAT_LIVE_AUTH_SECRET",
      "BACKEND_CHAT_LIVE_AUTH_SECRET_ARN",
    );
  }

  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} does not contain SecretString`);
  }

  const value = response.SecretString.trim();
  if (value === "") {
    throw new Error(`Secret ${secretArn} must not be empty`);
  }

  resolvedBackendChatLiveAuthSecret = value;
  return resolvedBackendChatLiveAuthSecret;
}
