# Cloud Functions params for the gaycruisebingo project (issue #101 / #120).
# Gitignored (functions/.gitignore); mirrors functions/.env.example defaults so
# `firebase deploy --only functions` has explicit values in non-interactive mode.
# RESEND_API_KEY is NOT here — it is a Secret Manager secret (already set).
EMAIL_FROM={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/EMAIL_FROM }}
ADMIN_NOTIFY_EMAIL=
APP_BASE_URL={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/APP_BASE_URL }}
# App Check enforcement for submitBugReport (#44/#158). Default off; declared
# explicitly so a non-interactive deploy does not stall on param resolution.
BUG_REPORT_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/BUG_REPORT_APP_CHECK }}
# Cloud Vision moderateProof gate (#126). Off — moderateProof is not exported.
ENABLE_VISION_MODERATION={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/ENABLE_VISION_MODERATION }}

# Added 2026-08-13: firebase resolveParams requires every declared param to be
# present by name, and a code-level default does NOT exempt it (see #724 for the
# same class in the e2e harness). Both values below are the documented defaults
# for THIS project, so behaviour is unchanged.
# Empty = no Reply-To header at all (the shipped default).
EMAIL_REPLY_TO=
# Conventional Gen2 Cloud Functions URL for the gaycruisebingo project.
EMAIL_UNSUBSCRIBE_URL={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/EMAIL_UNSUBSCRIBE_URL }}

# Added 2026-08-18 (#671): per-Edition EMAIL_FROM overrides. Left blank —
# none of gaycruisebingo.com/vacaybingo.com/fiveacross.app are Resend-verified
# yet, so every send keeps falling back to EMAIL_FROM above until a brand's
# domain is verified and this project's copy of the matching line is set.
EMAIL_FROM_GCB={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/EMAIL_FROM_GCB }}
EMAIL_FROM_VACAY={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/EMAIL_FROM_VACAY }}
EMAIL_FROM_FIVEACROSS={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/EMAIL_FROM_FIVEACROSS }}

# App Check enforcement for the auth-handoff endpoint. Inert default (matches
# functions/src/params.ts and .env.example); present here so non-interactive
# `firebase deploy` param resolution does not hard-fail (#767).
AUTH_HANDOFF_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/AUTH_HANDOFF_APP_CHECK }}

# approvePrompts callable (#1275): App Check enforcement toggle, off until clients attest (ADR 0015).
APPROVE_PROMPTS_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/APPROVE_PROMPTS_APP_CHECK }}
SUBMIT_PROMPT_APP_CHECK={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/functions-gaycruisebingo/SUBMIT_PROMPT_APP_CHECK }}
