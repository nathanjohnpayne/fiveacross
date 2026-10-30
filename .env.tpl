# Firebase web app config for gaycruisebingo — non-secret client identifiers
# (baked into the client bundle by design; security is enforced by Firestore/
# Storage rules + Auth, not by hiding these). Gitignored. Fetched via
# `firebase apps:sdkconfig WEB --project gaycruisebingo`; regenerate anytime.
VITE_FIREBASE_API_KEY={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_API_KEY }}
VITE_FIREBASE_AUTH_DOMAIN={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_AUTH_DOMAIN }}
VITE_FIREBASE_PROJECT_ID={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_PROJECT_ID }}
VITE_FIREBASE_STORAGE_BUCKET={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_STORAGE_BUCKET }}
VITE_FIREBASE_MESSAGING_SENDER_ID={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_MESSAGING_SENDER_ID }}
VITE_FIREBASE_APP_ID={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_APP_ID }}
VITE_FIREBASE_MEASUREMENT_ID={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_FIREBASE_MEASUREMENT_ID }}
VITE_EVENT_ID={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_EVENT_ID }}
POSTHOG_API_KEY={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/POSTHOG_API_KEY }}
POSTHOG_HOST={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/POSTHOG_HOST }}

# PostHog client (added for #96; phc_ project key is client-safe)
# Events route first-party through the reverse proxy (#149) → PostHog US. The
# proxy at d.gaycruisebingo.com must forward ingestion + static assets to
# us.i.posthog.com before deploying, or client analytics will fail.
VITE_POSTHOG_KEY={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_POSTHOG_KEY }}
VITE_POSTHOG_HOST={{ op://Private/nxo3433p725mqz2a4gz7wru4ve/local/VITE_POSTHOG_HOST }}
