---
spec_id: sec-clear-text-logging-seed
status: accepted
tested: false
reason: One-off ops/admin script with no runtime unit surface; verified by rerunning the seed and the CodeQL re-scan.
---

# Security: redact `ADMIN_UID` from the seed script log (`scripts/seed.mjs`)

CodeQL raised a high `js/clear-text-logging` finding (alert #2) against `scripts/seed.mjs`: the final `console.log` echoed the raw env-sourced `ADMIN_UID` roster (`Admins: <uid>, <uid>`). A Google uid is an identifier rather than a credential, so the practical risk was low, but the alert is resolved cleanly by redaction instead of a dismissal.

The log now prints `Admins: set (<count>)` when the roster parsed non-empty—the count preserves the operational signal that every comma-separated uid parsed, without printing any uid—and keeps the existing `No ADMIN_UID set — …` guidance otherwise.

No test accompanies this spec: the seed is a one-off ops/admin script (run directly with live Application Default Credentials) with no runtime unit surface, and the change is a single log line. Verification is operational—rerun the seed and confirm no uid is printed, and confirm CodeQL alert #2 closes on the next default-branch scan.
