# Cloud Functions params for the fiveacross project (Bodega Bay / Five Across).
# Gitignored (functions/.gitignore); mirrors functions/.env.example so
# `firebase deploy --only functions` has explicit values in non-interactive mode.
# RESEND_API_KEY is NOT here — it is a Secret Manager secret on this project.
EMAIL_FROM={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/EMAIL_FROM }}
ADMIN_NOTIFY_EMAIL=
APP_BASE_URL={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/APP_BASE_URL }}
# App Check enforcement for submitBugReport. Off — App Check is opt-in and
# unset on fiveacross (ADR 0008); declared so non-interactive deploy resolves.
BUG_REPORT_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/BUG_REPORT_APP_CHECK }}
# Cloud Vision moderateProof gate. Off — moderateProof is not exported.
ENABLE_VISION_MODERATION={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/ENABLE_VISION_MODERATION }}
EMAIL_REPLY_TO=
EMAIL_UNSUBSCRIBE_URL={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/EMAIL_UNSUBSCRIBE_URL }}

# Added 2026-08-18 (#671): per-Edition EMAIL_FROM overrides. Left blank —
# none of gaycruisebingo.com/vacaybingo.com/fiveacross.app are Resend-verified
# yet, so every send (Vacay AND Five Across hosts on this project) keeps
# falling back to EMAIL_FROM above until a brand's domain is verified and
# this project's copy of the matching line is set.
EMAIL_FROM_GCB={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/EMAIL_FROM_GCB }}
EMAIL_FROM_VACAY={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/EMAIL_FROM_VACAY }}
EMAIL_FROM_FIVEACROSS={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/EMAIL_FROM_FIVEACROSS }}

# App Check enforcement for the auth-handoff endpoint. Inert default (matches
# functions/src/params.ts and .env.example); present here so non-interactive
# `firebase deploy` param resolution does not hard-fail (#767).
AUTH_HANDOFF_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/AUTH_HANDOFF_APP_CHECK }}

# approvePrompts callable (#1275): App Check enforcement toggle, off until clients attest (ADR 0015).
APPROVE_PROMPTS_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/APPROVE_PROMPTS_APP_CHECK }}
SUBMIT_PROMPT_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-fiveacross/SUBMIT_PROMPT_APP_CHECK }}
