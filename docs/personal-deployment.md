# Personal free-tier deployment

How this fork is deployed outside AWS, at zero hosting cost, for a single user.

## Branch model

- `main` is an exact mirror of `upstream/main`
  (`kirill-markin/flashcards-open-source-app`). Nothing is committed to it
  directly; it only ever fast-forwards from upstream.
- `personal` carries every change in this document. Deployments track `personal`.
- The `upstream` remote has its push URL disabled on purpose, so no local
  mistake can push this fork's work back to the original project.

To take upstream changes: fast-forward `main` from `upstream/main`, then merge
`main` into `personal`. Upstream lands several hundred commits a month, so
expect conflicts wherever this branch has diverged — mostly `apps/auth` and
`apps/backend/src/aws`.

## Architecture

```
Vercel (Hobby)     SPA + rewrites for /v1/* and /auth/*  ─┐
                                                          │ same origin,
Render (free)      cardly-backend, cardly-auth  ←─────────┘ so session cookies work
Neon (free)        Postgres
AWS Cognito        identity only (EMAIL_OTP), free at this scale
```

The rewrites in `apps/web/vercel.json` are the load-bearing part. The browser
only ever talks to the Vercel hostname, so the session cookie is first-party and
no CORS or cross-site cookie problem exists. Without the proxy the cookie is
`SameSite=Lax` across two unrelated hostnames and never gets sent, which fails as
a silent login loop rather than as an error.

## What differs from upstream

| Area | Upstream (AWS) | Here |
| --- | --- | --- |
| Runtime | Lambda behind API Gateway | Long-lived Node container |
| CSRF / chat-live secrets | Secrets Manager ARN | `BACKEND_CSRF_SECRET` env var |
| Web/API/auth origins | `app.` / `api.` / `auth.` subdomains | one Vercel origin + rewrites |
| Postgres | RDS in a private VPC | Neon |

The only source change this required is an environment-variable fallback in
`apps/backend/src/aws/secrets.ts`, plus the two callers that used to refuse a
missing ARN before that fallback could be reached. Everything else was already
environment-driven, because upstream supports self-hosting.

## Prerequisites

1. Neon project (Postgres 17+).
2. Render account.
3. Vercel account.
4. AWS account with a Cognito user pool that has `EMAIL_OTP` sign-in enabled,
   plus an app client. **Confirm the free tier covers passwordless `EMAIL_OTP`
   before relying on it** — the tier that includes it has changed over time.
5. `psql` locally, to run the migrations.

## Runbook

Each step has a check. Do not move on until it passes.

### 1. Database

Create the Neon project, then run the migrations from a local checkout:

```bash
export MIGRATION_DATABASE_URL='postgresql://<owner>:<pw>@<host>/<db>?sslmode=require'
export BACKEND_DB_PASSWORD='<generate one>'
export AUTH_DB_PASSWORD='<generate one>'
export REPORTING_DB_PASSWORD='<generate one>'
bash scripts/deploy/migrate.sh
```

This applies `db/migrations/*.sql` in order, then `db/views/*.sql`, then sets the
passwords for the `backend_app`, `auth_app` and `reporting_readonly` roles the
migrations created.

**Check:** the script finishes without error, and `\dn` lists the `org`,
`content`, `sync`, `auth`, `ai`, `catalog`, `community` and `analytics` schemas.

**Watch for:** the migrations only need the `pgcrypto` and `pg_trgm` extensions
and no superuser rights, so they should apply cleanly. The part to verify on
Neon specifically is that roles created through SQL can then open connections —
that is how the two services authenticate.

The services connect as the runtime roles, not as the owner:

- backend: `postgresql://backend_app:$BACKEND_DB_PASSWORD@<host>/<db>?sslmode=require`
- auth: `postgresql://auth_app:$AUTH_DB_PASSWORD@<host>/<db>?sslmode=require`

### 2. Backend on Render

Apply `render.yaml` as a Blueprint. Render prompts for every `sync: false`
value. For this step only, override `AUTH_MODE` to `none` and add
`ALLOW_INSECURE_LOCAL_AUTH=true`, so the pipeline can be proven before Cognito
exists.

**Check:** `GET https://<backend>.onrender.com/v1/health` returns
`{"status":"ok", ...}` with a `dbTime`. That proves the container booted, the
build produced a working image, and Postgres is reachable.

> `AUTH_MODE=none` makes every request the user `local` with no credential
> checked at all. On a public URL that means anyone holding the link is you. It
> exists here to isolate "does the pipeline work" from "does auth work", and
> step 5 removes it. Do not share the URL until then.

### 3. Web on Vercel

Import the repo with **Root Directory = `apps/web`** and the branch set to
`personal`. Two settings matter:

- Enable **"Include source files outside of the Root Directory"**. The web build
  imports the scheduler from `apps/backend/src/scheduling` to avoid keeping a
  fourth copy of the FSRS algorithm, so the build fails without it.
- Replace the two `REPLACE-WITH-*` hosts in `apps/web/vercel.json` with the
  Render hostnames. Vercel does not interpolate environment variables into
  rewrite destinations, so these have to be literal.

Environment variables:

```
VITE_API_BASE_URL=https://<project>.vercel.app/v1
VITE_AUTH_BASE_URL=https://<project>.vercel.app/auth
VITE_APP_BASE_URL=https://<project>.vercel.app
```

These must be absolute origins, not paths: `buildLoginUrl` in
`apps/web/src/api/authUrls.ts` calls `new URL()` on the auth base, which throws
on a relative value.

**Check:** the app loads, and the network tab shows `/v1/...` requests answered
by the Vercel origin rather than by Render directly.

### 4. Cognito

Create the user pool and app client, then set on both Render services:
`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `COGNITO_REGION`. Set
`ALLOWED_REDIRECT_URIS` and `BACKEND_ALLOWED_ORIGINS` to the Vercel origin.

Leave `COOKIE_DOMAIN` unset. `.vercel.app` is on the Public Suffix List, so a
domain-scoped cookie cannot be set for it; host-only is both the only option and
the correct one behind the proxy.

**Check:** sign in with a real email and receive the code.

### 5. Close the hole

Set `AUTH_MODE=cognito` and remove `ALLOW_INSECURE_LOCAL_AUTH` from the backend.

**Check:** a request with no credential returns 401. This step is not optional.

## Known limitations

- **Render free services sleep** after roughly 15 minutes idle, and the next
  request pays a cold start. The app is offline-first, so studying keeps working
  from IndexedDB while the backend wakes; the delay is felt at sign-in and first
  sync. Render's free allowance covers roughly one always-on service, so if one
  of the two is kept warm it should be the backend.
- **No media and no AI yet.** Both are lazy, so the app boots without them, but
  the routes fail until `MEDIA_ASSETS_S3_BUCKET_NAME` and `OPENAI_API_KEY` are
  configured.
- **Web has no guest mode.** `apps/backend/src/guestAuth/webPlatform.ts` refuses
  the `web` guest platform on every authenticated surface — sync included. A web
  guest session is an analytics credential only. Sign-in is required from day
  one; only iOS and Android can run as guests.
- **iOS and Android are not deployed.** Nothing in the code prevents it; the
  store fees do.
- **Email delivery to third parties needs a verified domain.** For a single user
  sending to their own address this does not bite, but opening sign-up to other
  people does require a real domain.

## Pending changes (deliberately deferred)

Recorded here so the deployment is not blocked on them.

1. **Installable PWA.** `apps/web/index.html` has no manifest, no
   `apple-touch-icon` and no service worker. Two consequences on iOS: Safari
   evicts IndexedDB after 7 days without a visit, and IndexedDB is this app's
   local source of truth, so a week away wipes local state and loses anything
   still in the outbox. Home-screen web apps are exempt from that eviction. A
   service worker would additionally let the app open instantly while Render is
   asleep, which is the single biggest quality-of-life win available here.
   Coordinate it with `apps/web/src/staleBundleReload.ts`, which already handles
   stale bundles after a deploy.
2. **Remove the App Store prompt.** `MobileAppPromotionDialog` fires on the
   review screen on mobile web and links to the upstream author's iOS app, which
   is not this deployment.
3. **Media on Cloudflare R2.** Five `new S3Client({})` sites need an `endpoint`,
   `region: "auto"` and path-style addressing.
4. **Cardly branding.** Roughly 20 files still carry the upstream name, domain
   and legal links.
5. **Replace Cognito.** The whole dependency is six functions in
   `apps/auth/src/server/cognito/cognitoAuth.ts` plus two JWT verifiers, and the
   rest of the system reads only `sub` and `email` from the token. Supabase Auth
   maps onto those six almost one to one. Doing this removes AWS entirely.
6. **Chat worker and cron jobs.** `chat/worker/invoke.ts` still dispatches
   through `InvokeCommand`, and two scheduled jobs run at `rate(1 minute)` under
   EventBridge. On a long-lived container both get simpler: an in-process call
   and `setInterval`. Only needed once AI chat is switched on.

## Known test failure on Windows

`src/entrypoints/directImageIngestion/lambda.test.ts` fails locally on Windows
because it asserts on forward-slash module paths. It is unrelated to this
deployment work and passes in CI on Linux.
