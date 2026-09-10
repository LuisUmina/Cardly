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
Supabase Auth      identity only (email OTP), no AWS account anywhere
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
| Identity | Cognito user pool | Supabase Auth, verified through its JWKS |

Two source changes carry all of this. An environment-variable fallback in
`apps/backend/src/aws/secrets.ts`, plus the two callers that used to refuse a
missing ARN before that fallback could be reached; and the identity provider
swap described under step 4. Everything else was already environment-driven,
because upstream supports self-hosting.

## Prerequisites

1. Neon project (Postgres 17+).
2. Render account.
3. Vercel account.
4. Supabase project, used only as the identity provider. Its own database is
   irrelevant here; app data lives in Neon. That separation is not a preference:
   this project owns a schema literally named `auth` with 16 tables, and Supabase
   manages a schema of that name for its own auth service.
5. Node 24 locally. The psql client is not required; see step 1.

Generated secrets live in `.env.personal-deployment` at the repository root,
which `.gitignore` already excludes through `**/.env.*`. It holds the three
runtime role passwords and `SESSION_ENCRYPTION_KEY`, which must be exactly 64
hex characters — `apps/auth/src/server/crypto.ts` rejects anything else, and
Render's `generateValue` does not produce that shape, which is why that one
variable is `sync: false` rather than generated.

## Runbook

Each step has a check. Do not move on until it passes. All four steps are
complete and verified as of 2026-09-10; the deployment is live at
`https://cardly-nine.vercel.app`.

### 1. Database

**Name the database `flashcards`.** Not `neondb`, not `cardly`. Four migrations
grant connect rights by literal name:

```
db/migrations/0001_initial_schema.sql:134   GRANT CONNECT ON DATABASE flashcards TO app;
db/migrations/0024_auth_runtime_roles.sql:21-22
db/migrations/0025_remove_legacy_app_role.sql:89
db/migrations/0044_reporting_readonly_role.sql:24
```

Any other name fails the run with `database "flashcards" does not exist`.
Matching the name is deliberately preferred over editing the SQL: every line
this branch does not diverge from upstream is one less merge conflict later.

Then run the migrations from a local checkout:

```bash
export MIGRATION_DATABASE_URL='postgresql://<owner>:<pw>@<host>/flashcards?sslmode=require'
export BACKEND_DB_PASSWORD='<from .env.personal-deployment>'
export AUTH_DB_PASSWORD='<from .env.personal-deployment>'
export REPORTING_DB_PASSWORD='<from .env.personal-deployment>'

npm ci --prefix apps/backend      # once, this is where the script resolves `pg`
node scripts/deploy/migrate-node.mjs
```

`scripts/deploy/migrate-node.mjs` is a Node port of the upstream
`scripts/deploy/migrate.sh`, added because this deployment applies migrations
from a Windows workstation where the psql client is not installed. Both apply
`db/migrations/*.sql` in order, then `db/views/*.sql`, then set the passwords for
the `backend_app`, `auth_app` and `reporting_readonly` roles, then reconcile
`ADMIN_EMAILS`. Use `migrate.sh` instead wherever psql is available; it stays the
reference implementation.

The port is safe because no migration uses a psql meta-command, and none uses a
statement that cannot run inside a transaction. That is not luck:
`db/migrations/0118_*.sql` documents choosing plain `CREATE INDEX` over
`CONCURRENTLY` precisely because each file is applied as one transaction.

Use the **direct** endpoint here, not the `-pooler` one. Migrations run DDL,
`CREATE ROLE` and `ALTER ROLE ... SET`, none of which belong on a transaction
pooler.

**Check:** 129 rows in `schema_migrations`, and the `org`, `content`, `sync`,
`auth`, `ai`, `catalog`, `community`, `analytics`, `progress`, `security` and
`support` schemas all present.

**Result on Neon (verified 2026-09-09):** all 129 migrations and the one view
applied, 76 tables, and the `backend_app`, `auth_app` and `reporting_readonly`
roles created with login rights. The open question from the first draft of this
document — whether roles created through SQL can then open connections on Neon —
is answered: they can, on both the direct and the pooled endpoint.

The services connect as the runtime roles, not as the owner, and they use the
**pooled** endpoint:

- backend: `postgresql://backend_app:<pw>@<host>-pooler.<region>.aws.neon.tech/flashcards?sslmode=require`
- auth: `postgresql://auth_app:<pw>@<host>-pooler.<region>.aws.neon.tech/flashcards?sslmode=require`

The pooler is safe for the runtime because `applyDatabaseScopeInExecutor` in
`apps/backend/src/database/core.ts` sets the row-level-security context with
`set_config('app.user_id', $1, true)` — the trailing `true` is `is_local`, so the
setting is transaction-scoped, which is exactly the unit PgBouncer multiplexes.
Had it been session-scoped, pooling could have leaked one user's RLS context into
another user's request, and the direct endpoint would have been mandatory.

Both connection strings are already built and verified in
`.env.personal-deployment`.

**Keep `?sslmode=require` in both.** It is load-bearing, not decoration.
`createDatabasePool` in `apps/backend/src/database/core.ts` passes
`ssl: process.env.DB_SECRET_ARN ? true : false`, so outside AWS it hands the
driver an explicit `ssl: false`. Connections still get TLS only because
node-postgres merges the parsed connection string over the explicit options, so
`sslmode=require` wins. Drop it from the URL and the pool would try plaintext
against a provider that requires TLS. Four modules share that same
`DB_SECRET_ARN ? true : false` shape (`database/core.ts`,
`database/sessionAdvisoryLock.ts`, `productAnalytics/writer.ts`, and
`apps/auth/src/db.ts`), and all of them are fine for the same reason.

**Deployed services (verified 2026-09-09):**

- backend: `https://cardly-backend-yz2m.onrender.com` — `/v1/health` returns
  `status: ok` with a live `dbTime`
- auth: `https://cardly-auth.onrender.com` — `/health` returns `ok: true`

Render appended a random suffix to the backend service name but not to the auth
one, so neither hostname can be assumed from the service name; read both from
the Render dashboard.

### 2. Backend on Render

Apply `render.yaml` as a Blueprint. Render prompts for every `sync: false`
value. `AUTH_MODE` is not among them: it is a static `cognito` in the blueprint
and stays that way. The name outlived the provider — it selects "verify real
identity tokens" as opposed to `none`, and the only other accepted value is
`none`, so changing it would be a rename with a failure mode and no benefit.

The identity provider does not exist yet at this point, so fill `SUPABASE_URL`
with a placeholder and correct it in step 4. That works because `getAuthConfig`
only validates the mode string, the JWKS verifier is built lazily on the first
authenticated request, and `/v1/health` is unauthenticated. The service boots and
reports healthy on placeholder identity config.

**Check:** `GET https://<backend>.onrender.com/v1/health` returns
`{"status":"ok", ...}` with a `dbTime`. That proves the container booted, the
build produced a working image, and Postgres is reachable.

> An earlier draft of this runbook used `AUTH_MODE=none` for this step, which
> makes every request the user `local` with no credential checked at all. That
> was never necessary: nothing in this check touches authentication. The
> placeholder route above proves exactly the same things without ever exposing an
> open URL, so `none` stays out of this deployment entirely.

### 3. Web on Vercel

Import the repo with **Root Directory = `apps/web`**. The import flow offers no
branch selector and always takes the repository default, so the first deployment
comes from `main` and is throwaway; the branch is corrected afterwards.

**The production domain is `cardly-nine.vercel.app`.** `cardly.vercel.app` was
already taken, so Vercel appended a suffix. The name is not knowable in advance,
and eleven environment variables across Vercel and both Render services carry it,
so read it from Settings → Environments → Production → Domains before filling any
of them in.

Settings that matter, all under Settings → Build and Deployment → Root Directory:

- Enable **"Include files outside the root directory in the Build Step"**. The
  web build imports the scheduler from `apps/backend/src/scheduling` to avoid
  keeping a fourth copy of the FSRS algorithm, so the build fails without it.
- Disable **"Skip deployments when there are no changes to the root
  directory"**. Vercel decides that from the root directory alone and cannot see
  the `apps/backend/src/scheduling` import, so a scheduler change would ship a
  web app whose review behavior differs from what was deployed.

Also replace the two `REPLACE-WITH-*` hosts in `apps/web/vercel.json` with the
Render hostnames. Vercel does not interpolate environment variables into rewrite
destinations, so these have to be literal.

Environment variables:

```
VITE_API_BASE_URL=https://cardly-nine.vercel.app/v1
VITE_AUTH_BASE_URL=https://cardly-nine.vercel.app/auth
VITE_APP_BASE_URL=https://cardly-nine.vercel.app
```

Three traps here, all of which cost a round trip the first time:

1. **Type must be `Config`, not `Secret`.** Vercel refuses to save a `VITE_`
   variable as a secret, because the prefix means Vite compiles the value into
   the browser bundle. It is right to refuse: these are public URLs. A variable
   already saved as `Secret` cannot be converted, so it has to be deleted and
   recreated.
2. **Vercel pre-fills twelve variables scraped from the root `.env.example`** —
   `MIGRATION_DATABASE_URL`, `DATABASE_URL`, the role passwords, `COOKIE_DOMAIN`
   and so on. Not one of them belongs to the web build; none carries a `VITE_`
   prefix, so Vite ignores them all. Remove all twelve rather than leaving
   database credentials parked in a frontend project.
3. **They must be absolute origins, not paths.** `buildLoginUrl` in
   `apps/web/src/api/authUrls.ts` calls `new URL()` on the auth base, which
   throws on a relative value.

Then point production at this branch: Settings → **Environments** → Production →
Branch Tracking → `personal`. It is not under Settings → Git, where a production
branch used to live.

**Redeploy will not pick the new branch up.** The dialog says it plainly —
"Create a new deployment with the selected deployment's source code and the
latest project settings" — so it rebuilds the old `main` commit with new
settings. Branch tracking only governs deployments triggered by a push. Push a
commit to `personal` to get the first correct production build.

**Check:** the app loads, and the network tab shows `/v1/...` requests answered
by the Vercel origin rather than by Render directly.

**Result (verified 2026-09-09):** the whole chain works.

| Probe | Result |
| --- | --- |
| `GET https://cardly-nine.vercel.app/` | 200, `text/html` |
| `GET https://cardly-nine.vercel.app/v1/health` | 200 with a live `dbTime` |
| `GET https://cardly-nine.vercel.app/auth/health` | 200 `{"ok":true}` |
| `GET https://cardly-nine.vercel.app/v1/me` | 401 `AUTH_UNAUTHORIZED` |

Two of those are worth more than they look. The rewrites live only in
`apps/web/vercel.json`, which exists only on `personal`, so `/v1/health`
answering at all proves the build came from the right branch. And the 401 on
`/v1/me` proves authentication is enforced, which is what the abandoned
`AUTH_MODE=none` step would have given away.

The build also picked the environment up correctly: `assets/config-*.js` carries
the three literal `https://cardly-nine.vercel.app` URLs, and the
`https://api.${baseDomain}` fallback in `apps/web/src/config.ts` is absent from
every chunk. Vite substituted the values at build time and dropped the dead
branch. Had the variables been missing, that fallback would still be there and
the app would be calling a hostname that does not exist.

### 4. Identity provider

Cognito is replaced by Supabase Auth. The whole dependency was six functions in
one file plus two JWT verifiers, because nothing downstream knows which provider
issued a token: it reads `sub` and `email` and nothing else.

What changed:

| File | Change |
| --- | --- |
| `apps/auth/src/server/identity/supabaseAuth.ts` | New. The same six exported functions, against Supabase's auth endpoints |
| `apps/auth/src/server/identity/tokenVerifier.ts` | New. JWKS verification with `jose` |
| `apps/backend/src/auth/identityTokenVerifier.ts` | New. Same, for the backend |
| 8 route files in `apps/auth/src/routes` | One import line each |
| `apps/backend/src/auth/index.ts` | Verifier swapped; `cognitoUsername` now carries `sub` |
| `apps/backend/src/auth/cognitoUsers.ts` | Deletes through Supabase's admin users endpoint |

Three decisions worth knowing:

- **The provider raises the existing typed-error shape.** Four route modules
  already branch on `getNormalizedCognitoErrorType` and
  `isCognitoInvalidEmailError`, so Supabase failures are mapped onto the same
  `cognitoType` vocabulary and every one of those branches keeps working
  untouched. The naming is imperfect; a rename would touch four route files for
  no behavior change.
- **`aws-jwt-verify` could not be reused.** It verifies RSA against Cognito's
  JWKS layout, and Supabase signs with ES256. `jose` covers ES256, RS256 and
  HS256, so it replaces it in both services.
- **`cognitoAuth.ts` is left in place, unused.** Deleting it would conflict with
  every upstream change to a file this branch no longer calls.

Configuration. On **both** Render services: `SUPABASE_URL`. On `cardly-auth`
only: `SUPABASE_ANON_KEY`. On `cardly-backend` only: `SUPABASE_SERVICE_ROLE_KEY`,
which is used by exactly one path, account deletion, and which bypasses row-level
security — so it never goes near the auth service, which deletes no users.

Prefer asymmetric signing keys in the Supabase project, so neither service holds
a secret that can mint tokens. `SUPABASE_JWT_SECRET` exists only for a project
still on legacy HS256 keys and should stay unset.

Set `COOKIE_DOMAIN` to the bare Vercel hostname with **no leading dot**, for
example `cardly-nine.vercel.app`. Two constraints meet here: `validateEnv` in
`apps/auth/src/index.ts` refuses to start without the variable whenever
`NODE_ENV` is not `development`, and a leading dot would name `.vercel.app`,
which is on the Public Suffix List and which browsers reject. The exact host is a
subdomain of that suffix, so it is accepted.

**Check:** sign in with a real email and receive the code.

**Result (verified 2026-09-10):** sign-in works end to end. The seeded demo card
appears after login, which proves more than authentication: the backend
provisioned the user, created a workspace, seeded onboarding content, and sync
delivered it to IndexedDB.

Four things had to be configured in Supabase beyond the keys, and three of them
were only discovered by running the flow:

1. **Email OTP length must be 8.** `verifyCode.ts` and `agentVerifyCode.ts` both
   match `/^\d{8}$/` and the login template sets `maxlength="8"`. Supabase's
   field accepts 6-10; anything but 8 is rejected by the app before the code ever
   reaches the provider, which surfaces as a confusing generic error.
2. **Custom SMTP is required, and not for volume.** Supabase will not let the
   email templates be edited without it, and the stock templates send a magic
   link with no code in them — so the app asks for eight digits that appear
   nowhere. Resend on its shared `onboarding@resend.dev` sender is enough for a
   single user; without a verified domain it only delivers to the address the
   Resend account was registered with, which therefore has to be the address you
   sign in with.
3. **Two templates need the code, not one.** "Magic link or OTP" covers returning
   users, but a brand-new address gets "Confirm sign up" instead, because the
   account does not exist yet. Editing only the first leaves the very first
   sign-in — the only one that matters on a fresh deployment — still sending a
   bare link. Both need `{{ .Token }}`.
4. **Site URL defaults to `http://localhost:3000`.** Set it to the Vercel origin
   under URL Configuration. It only matters for link-based flows, which this
   deployment does not use, but a stray link click otherwise lands on a dead
   localhost page.

The magic link is deliberately removed from both templates. It points at
Supabase's own redirect flow, which this app does not implement — leaving it in
gives the reader a button that goes somewhere half-working while the app waits
for a number.

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
5. **Chat worker and cron jobs.** `chat/worker/invoke.ts` still dispatches
   through `InvokeCommand`, and two scheduled jobs run at `rate(1 minute)` under
   EventBridge. On a long-lived container both get simpler: an in-process call
   and `setInterval`. Only needed once AI chat is switched on.

## Known test failure on Windows

`src/entrypoints/directImageIngestion/lambda.test.ts` fails locally on Windows
because it asserts on forward-slash module paths. It is unrelated to this
deployment work and passes in CI on Linux.
