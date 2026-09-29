# App Review Mode Runtime Config


## Visual Context

Canonical visual owner: [consent-protocol](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Purpose
Move app-review-mode control from frontend build-time variables to backend runtime configuration.

## Endpoints
- `GET /api/app-config/review-mode`
- `POST /api/app-config/review-mode/session`

## Environment Variables (backend)
- `APP_REVIEW_MODE`  
  Truthy values: `1`, `true`, `yes`, `on`. Ignored in production (see below).
- `REVIEWER_UID`
- `REVIEWER_VAULT_PASSPHRASE` (non-production reviewer smoke bypass only)

## Response
- When disabled:
```json
{
  "enabled": false
}
```

- When enabled:
```json
{
  "enabled": true
}
```

## Session mint response

`POST /api/app-config/review-mode/session`

```json
{
  "token": "<firebase-custom-token>"
}
```

## Notes
- This endpoint is included via the shared health router.
- Frontend web requests can proxy through Next API routes.
- Native iOS/Android clients can call backend directly.
- No reviewer password is exposed to clients.
- The passphrase bypass exists only so UAT/browser smoke can mint the same reviewer token without creating another user.
- `UAT_SMOKE_*` and `KAI_TEST_*` are deprecated one-release aliases.

## Production: backend-only review (founder decision, 2026-09-29)

The App Store binary talks to production. Apple still needs a demo sign-in, and the founder
decided the reviewer must not be visible in the interface. On production, review is therefore a
dedicated reviewer **account**, not a mode the app can see.

What production does, whatever `APP_REVIEW_MODE` says (`api/routes/health.py`):

- `GET /api/app-config/review-mode` always returns `{"enabled": false}`.
- `POST /api/app-config/review-mode/session` always returns `403 App review mode is disabled`,
  the same answer a disabled lane gives, and logs
  `app_review_mode.session_refused reason=production_runtime`. The mint is a sign-in with no
  credential; on production it would hand the reviewer account to anyone who asked.
- A production frontend build (`NEXT_PUBLIC_APP_ENV=production`) never calls either endpoint
  (`ApiService.getAppReviewModeConfig` returns `enabled: false`; `createAppReviewModeSession`
  throws). The "Continue as reviewer" button also needs native test mode, which is compiled out
  of Release iOS builds (`#if DEBUG` in `NativeTestSupport.swift`).
- Production detection is `ENVIRONMENT=production` or `APP_RUNTIME_PROFILE=production`. The live
  service sets `ENVIRONMENT=production`.

How the reviewer gets in, with no reviewer-specific backend grant:

1. **Sign-in** is the normal Google (or Apple) sign-in with a dedicated reviewer account that
   Hussh owns. The app has no other sign-in method, and the production test-phone allowlist is
   not a sign-in method.
2. **Phone mandate.** The account claims one number from `HUSHH_PROD_PHONE_TEST_NUMBERS` with
   the fixed code `HUSHH_PROD_PHONE_TEST_CODE` (`/api/account/phone/uat-test/*` in
   `api/routes/account.py`, honoured on production only when `HUSHH_PROD_PHONE_TEST_ENABLED` and
   the challenge secret are set). The allowlist is UID-agnostic: it grants a verified synthetic
   number, nothing else. Once claimed, later sign-ins do not ask again.
3. **Vault.** The reviewer vault is created in the app with a generated passphrase. Apple gets
   the passphrase in the App Store Connect review notes and types it; the app never fills it in.

Where the reviewer identity lives:

| Secret (project `hushh-pda`) | Holds | Bound to the production service? |
| --- | --- | --- |
| `REVIEWER_UID` | The production reviewer's Firebase UID | No |
| `REVIEWER_VAULT_PASSPHRASE` | The production reviewer's vault passphrase | No |

Both are for operator tooling only: the App Store submission notes and the iPhone device gate.
Production has no runtime use for either, and `config/deploy-env-coverage.json` keeps
`_REVIEWER_UID_SECRET` and `_REVIEWER_VAULT_PASSPHRASE_SECRET` out of `deploy-production.yml`.
`scripts/ops/sync_backend_runtime_secrets.py` re-writes an existing `REVIEWER_UID` to itself on
every production deploy (its legacy-fallback loop); that is expected and binds nothing.

**Never reuse the production reviewer as a UAT or dev `REVIEWER_UID`.** UAT and production share
the Firebase authority `hushh-pda`. A UID configured on UAT can be signed into from UAT, and the
only thing keeping that session off production is the lane claim described below.

## Lane containment: one Firebase authority (2026-09-29)

**The lanes share one Firebase authority.** The UAT and production backends both hold
`FIREBASE_ADMIN_CREDENTIALS_JSON` for project `hushh-pda`, so a Firebase ID token issued on
either lane is cryptographically valid on both. Until this change a review session minted on UAT
could be exchanged for an ID token and presented to the production API as the reviewer.

What contains it now:

1. **Every review-mode mint is marked.** `POST /api/app-config/review-mode/session` passes the
   developer claim `hushh_review_mint: "<lane>"` to `create_custom_token`, where the lane is the
   service's `ENVIRONMENT` (`dev`, `uat`, `development` on localhost). Firebase carries
   custom-token developer claims into every ID token of that sign-in, including refreshed ones.
2. **Every verifier refuses a marked token outside its own lane.**
   `refuse_foreign_review_mint` in `api/utils/firebase_auth.py` refuses a token whose
   `hushh_review_mint` is present and differs from this service's lane, and refuses every marked
   token on production (`ENVIRONMENT=production` or `APP_RUNTIME_PROFILE=production`), whatever
   the claim says. The refusal is the same `401 Invalid Firebase ID token` an invalid token gets,
   and logs `one.auth.review_mint_rejected env=<this lane> minted_for=<claim>`, never the token.
   Unmarked tokens (every ordinary Google, Apple, phone or trusted-device sign-in) are unaffected.
3. **A review session cannot mint an unmarked token.** Two routes turn a signed-in session into a
   fresh custom token that cannot inherit the claim: trusted-device approval
   (`/api/account/trusted-device-authorizations`, exchanged at `.../exchange`) and the Hushh Tech
   launch (`/api/v1/products/hushh-tech/launch/authorize`, exchanged at `.../launch/exchange`).
   Both refuse any marked session, on every lane, at the step where the session is presented
   (`403 TRUSTED_DEVICE_REVIEW_SESSION_REFUSED`, and `401 UNAUTHENTICATED` respectively).

Verification paths and how each is covered:

| Path | Coverage |
| --- | --- |
| `verify_firebase_bearer` (`api/utils/firebase_auth.py`), behind `require_firebase_auth`, `require_firebase_auth_read_only`, consent, notifications, session, SSE, agent chat, voice, voice actor proof, Hushh Tech and debug routes | Refuses directly |
| `_verify_browser_enrollment_identity` (`api/routes/account.py`) | Refuses directly, and refuses any marked session |
| `_verify_phone_claim_id_token` (`api/routes/account.py`, also used by `api/routes/ria.py`) | Refuses directly (a minted session is `custom`, not `phone`, so it already failed the provider check) |
| `_require_recent_firebase_auth`, `_authorize_firebase_watermark` (`api/routes/hushh_tech.py`) | Refuse directly; the second also refuses any marked session |
| `_recipient` (`api/routes/drive_sharing.py`) | Covered by its `require_firebase_auth_read_only` dependency on the same `Authorization` header, which runs first |
| Next.js `validateFirebaseToken` (`hushh-webapp/lib/auth/validate.ts`) | Pre-check only; every route that uses it forwards the same header to a backend route above |

What this does **not** do: it does not reach review sessions minted before the change. Those
carry no claim, and their refresh tokens keep producing unmarked ID tokens. Revoking the UAT
reviewer's refresh tokens ends them; production verifies with `check_revoked=True`, so a
revocation takes effect there within the 60-second positive cache.

The legacy production `REVIEWER_UID` value predating this decision (first version 2026-02-21)
is a Firebase user with no sign-in provider, so only a minted token can reach it. It cannot be
used through normal sign-in. Repoint the secret to the new account once that account exists.
