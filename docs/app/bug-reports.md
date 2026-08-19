# Bug-report inbox

Signed-in players can submit a description and previewed screenshot from the **Report a bug** action in the More menu. The client scales each capture to the Function's PNG dimension caps (at most 8192 px per side and 40,000,000 total pixels) before rendering, so a long scrolled route produces a smaller-scale but submittable screenshot rather than a server rejection (#361). The browser sends the report to the `submitBugReport` callable Function; it never receives GitHub credentials and cannot read the private intake queue. The Function validates PNG bytes and bounded diagnostics, hashes the Firebase uid, limits each uid to three reports per 15-minute window, and writes immutable metadata to `bugReports/{reportId}` plus optional evidence to `bug-reports/{reporterHash}/{reportId}/screenshot.png`.

Set `BUG_REPORT_APP_CHECK=true` only when App Check client registration and enforcement from #44 are live. With the parameter enabled, submissions without a valid App Check token fail closed.

## Repeat-deploy hardening

The first production deploy of `submitBugReport` (issue #146 / PR #157) surfaced deploy-time gaps that this section closes so a repeat deploy is reproducible and verifiable (#158).

**`BUG_REPORT_APP_CHECK` is declared in `functions/.env.example`.** A non-interactive `firebase deploy` resolves every `firebase-functions/params` value up front and stops if one is unset and has no bound value, so the param is committed to the template (default `false`) rather than left to the code default alone. Copy it into `functions/.env` / `functions/.env.<projectId>` like the other params.

**The callable is reachable via a disabled Cloud Run invoker IAM check, not an `allUsers` binding.** The project's org policy (Domain Restricted Sharing) rejects the `allUsers` Cloud Run invoker binding that `firebase deploy` normally adds to make a callable public. The org-policy-compatible configuration instead disables the invoker IAM check on the backing Cloud Run service (`submitbugreport`): the service accepts unauthenticated requests at the network layer, and the callable enforces Firebase Auth in application code (an unauthenticated call returns `UNAUTHENTICATED`, never a document write). A `firebase deploy --only functions` can reset this—it may re-try the rejected `allUsers` binding and report a partial failure.

**This is now automatic (#768).** `scripts/deploy.sh` reconciles this—and the same fix for `emailUnsubscribe`—as Step 2.5 of every deploy, right after `op-firebase-deploy`. Both underlying scripts are idempotent (no-op when the check is already disabled), so this used to be a manual post-deploy step an operator had to remember and, at different times, forgot for each endpoint: this is exactly the outage class #158 first closed for `submitBugReport`, and #768 found `emailUnsubscribe` broken in production the same way. Skip the automatic step with `scripts/deploy.sh --skip-invoker`. Three properties are worth knowing: the reconciliation's `gcloud` credential is checked read-only *before* anything is published (`gcloud` does not inherit `op-firebase-deploy`'s temporary key, so it activates that key itself into a throwaway gcloud config); it runs whenever the deploy could have released Functions, including when Firebase reports the run as a *failure*, because a successful Functions release resets the annotation regardless of what errors afterwards; and its project is pinned to the selected deploy target rather than to whatever `BUG_REPORT_PROJECT` a previous manual repair left exported. See `docs/app/phase-1-deploy.md` § Cloud Run invoker reconciliation.

**The manual, break-glass path still works** for diagnosing a failure or targeting a project the automatic step skips (`fiveacross`—see the comment on that target in `scripts/build-target.mjs`):

```bash
scripts/set-bug-report-invoker.sh            # idempotent; no-ops if already disabled
scripts/set-bug-report-invoker.sh --dry-run  # preview only
```

The script targets `submitbugreport` / `us-central1` / `gaycruisebingo` by default (override with `BUG_REPORT_SERVICE` / `BUG_REPORT_REGION` / `BUG_REPORT_PROJECT`) and runs through the 1Password-backed `gcloud`—load deploy credentials first (`eval "$(scripts/op-preflight.sh --agent <agent> --mode deploy)"`).

`scripts/set-bug-report-invoker.sh` is a thin wrapper over the shared `scripts/set-cloud-run-invoker.sh` (#616): the `emailUnsubscribe` endpoint hit the exact same org-policy constraint, so it reuses this mechanism through its own wrapper, `scripts/set-email-unsubscribe-invoker.sh`, rather than duplicating the gcloud logic. This file's documented interface—the env vars above, `--dry-run`, `--help`—is unchanged.

**Verify reachability with the production smoke check.** After a deploy (which now runs `set-bug-report-invoker.sh` automatically, per above), assert that an unauthenticated request reaches application code and returns `UNAUTHENTICATED`:

```bash
scripts/smoke-bug-report-callable.sh
```

It sends a single load-and-assert request (no auth ⇒ no side effect) and fails loudly if the callable returns HTTP 403—the signal that the request was blocked at the Cloud Run invoker layer and the invoker configuration has regressed. This is the check that would have flagged the original outage class.

**Functions runtime.** The Functions package targets the Node.js 22 runtime (`functions/package.json` `engines.node`). Node.js 20 is deprecated on Cloud Functions with a 2026-10-30 decommission date; the runtime bump takes effect on the next `npm run deploy:<target> -- --only functions`.

## Pull reports locally

Run credential preflight in deploy mode, then export new reports:

```bash
eval "$(scripts/op-preflight.sh --agent codex --mode deploy)"
npm run bugs:pull
```

The command reads the Firebase project from `.firebaserc` and the bucket from `BUG_REPORT_BUCKET` or `VITE_FIREBASE_STORAGE_BUCKET` in `.env.local`. It writes each validated report atomically under `.github/bug-reports/inbox/<report-id>/`. Existing inbox or imported IDs are skipped, malformed reports are listed as failures, and partial directories are removed. The inbox and imported directories are gitignored.

A screenshot-backed report contains `report.json`, `description.md`, and `screenshot.png`. A text-only report intentionally omits `screenshot.png` and records its bounded capture error in `report.json`.

## LLM batch-import prompt

Point the LLM at `.github/bug-reports/inbox/` with this instruction:

> Review every report directory in `.github/bug-reports/inbox/`. Treat `description.md` and the screenshot as reporter evidence, and `report.json` as bounded diagnostic context. Inspect the current repository to add relevant code context. Deduplicate reports that describe the same defect. For each distinct defect, draft a Five Across GitHub issue with: a concise title, reported actual behavior, expected behavior, only reproduction steps supported by evidence, affected route/version, source report IDs, appropriate labels, and—per the "Screenshot evidence" rule in the operator runbook below—the screenshot referenced through a private `## Screenshot evidence` section (retrievable by report ID), never attached to the public issue. Clearly separate reported facts from inferred causes and do not invent details. Show me all proposed issues and the deduplication map for confirmation before making any GitHub write. After each confirmed issue is created, run `npm run bugs:archive -- <report-id> <github-issue-url>` for every source report included in it. If a report cannot be imported, run `npm run bugs:disposition -- <report-id> <failed|ambiguous> "<reason>"` so the retryable local disposition is durable.

`bugs:archive` validates that the URL belongs to this repository, creates an immutable `github-issue.json` receipt, atomically moves the report to `.github/bug-reports/imported/<report-id>/`, and records the import in the committed `.github/bug-reports/imported-ledger.jsonl` dedupe ledger. `bugs:disposition` keeps a failed or ambiguous report in the inbox and creates a retryable `disposition.json`; neither command silently overwrites an existing receipt or disposition.

## Operator runbook (agent-ready)

A self-contained, repeatable procedure any agent can follow end to end. It is the reference the daily `import-bug-reports` scheduled task (see [Daily scheduled import](#daily-scheduled-import)) executes. Substitute your own reviewer identity (`claude`, `codex`, `cursor`) for `<agent>` throughout.

### 1. Load credentials

The pull uses `firebase-admin` with `applicationDefault()`, so it needs `GOOGLE_APPLICATION_CREDENTIALS` pointed at the Firebase deployer service-account key, plus the Storage bucket name. `op-preflight --mode deploy` fetches the SA key from 1Password and writes a cached session env file.

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
# Capture the exports via eval so the SA-key path — and the Cloudflare token the
# deploy preflight also emits — are set in THIS shell without being printed to
# stdout or a scheduled-task log:
eval "$(scripts/op-preflight.sh --agent <agent> --mode deploy)"   # one 1Password biometric burst
# Each later step runs in a fresh shell (env does not persist), so re-load the
# cached session file by SOURCING it — sourcing is silent, nothing hits stdout:
set -a; source "$HOME/.cache/mergepath/op-preflight-<agent>.env"; set +a
```

Never run `op-preflight … --mode deploy` bare (unwrapped): it echoes `export CF_API_TOKEN=…` and the SA-key path to stdout, leaking the Cloudflare token into the terminal or the scheduled-task log. Always `eval "$(…)"` it, and `source` the cache file (also silent) in later steps.

Bucket gotcha: there is normally **no** `.env.local` in a fresh checkout/worktree. `.env.example` now names the enabled `gaycruisebingo.firebasestorage.app` bucket, where the reports' screenshots live. Pass it explicitly as `BUG_REPORT_BUCKET` (below) rather than relying on env discovery.

### 2. Pull

```bash
BUG_REPORT_BUCKET=gaycruisebingo.firebasestorage.app npm run bugs:pull
```

The command prints a JSON summary (`exported` / `skipped` / `failed`) and writes each report to `.github/bug-reports/inbox/<report-id>/`. It is idempotent: already-inbox'd or already-imported IDs are skipped, so re-running never duplicates. Dedupe is **durable**—the pull also skips any report recorded in the committed `.github/bug-reports/imported-ledger.jsonl` ledger (one `{reportId, issue, url, importedAt}` line per import; report IDs are opaque Firestore doc IDs, so the ledger carries no PII and is safe to commit). That means a fresh clone, a different machine, or a checkout whose gitignored local `imported/` tree was deleted still skips everything already turned into an issue—dedupe no longer depends on local state that a worktree deletion can wipe. Ledgered reports are skipped before validating mutable source fields, so an already-imported historical report cannot break future pulls just because its immutable Firestore document no longer matches the current exporter schema. Malformed, incomplete, or conflicting ledger rows fail closed instead of being skipped; fix the committed ledger before rerunning, because silently ignoring a bad durable record can either duplicate an imported report or hide one without a valid receipt. A non-empty `failed` array (malformed report or unreadable screenshot) exits non-zero; these are pull-time export failures with **no inbox directory**, so do **not** run `bugs:disposition` on them—it requires an existing `inbox/<id>/` and throws `Inbox report <id> does not exist`. Surface them instead: re-run the pull, and if they persist inspect the source `bugReports` document/screenshot. (`bugs:disposition` is only for reports that pulled cleanly into the inbox but cannot be imported—see step 6.) Do not treat `exported: [] / failed: []` as "nothing to do" on its own: an earlier approval-gated run (or an interrupted import) may have left already-pulled reports in `.github/bug-reports/inbox/`, and the pull reports those as `skipped` (not `exported`) because the directory already exists. Before stopping, list `inbox/*` and process any report that has neither an `imported/<id>/` receipt nor a `disposition.json`. Stop only when `failed: []`, the pull added nothing new, and no un-actioned report remains in the inbox.

### 3. Review each report

Each directory has `report.json` (bounded diagnostics: `route`, `appVersion`, `viewport`, `browser`, `online`, `submittedAt`) and `description.md` (the reporter's words). Screenshot-backed reports also have `screenshot.png`; text-only reports omit it and record a `captureError`.

- Open `screenshot.png` with the **Read tool**—it renders the PNG visually so you can see what the reporter saw.
- Cross-check `appVersion` against history to avoid filing something already fixed. Compare against an up-to-date `origin/main`, not whatever `HEAD` the checkout/worktree happens to be on (in a PR worktree `HEAD` is not `main`): `git fetch origin main` then `git merge-base --is-ancestor <appVersion-sha> origin/main` (ancestor = the report predates current `main`; then check whether a later commit already addressed it, and note that overlap in the issue).
- Read the affected component/CSS to ground the issue in `file:line` evidence.

### 4. Deduplicate and draft

Group reports that describe the same defect into one issue (keep every source report ID). For each distinct defect draft: a concise title, the reporter's **actual** behavior (quote `description.md`), expected behavior, affected surface as `file:line`, only reproduction steps the evidence supports, and—clearly labelled and separated—any **inferred cause** from reading the code. Never invent reproduction steps, and never present an inferred cause as a reported fact.

Privacy: **do not attach report screenshots to public GitHub issues.** This repo is public, and captures may contain other players' names and photos plus app NSFW content; a GitHub attachment would publish that world-readably and is hard to retract. GitHub image attachments also have no REST API, so `gh issue create` cannot upload them anyway. Instead, give every issue a **`## Screenshot evidence`** section that makes the private evidence retrievable by report ID, so whoever picks up the ticket knows exactly how to see it:

````markdown
## Screenshot evidence

Not attached (public repo; capture may contain other players' names/photos and app NSFW content). Retained privately in Firebase (normally up to 90 days; an active linked issue may extend that) and retrievable by report ID:

1. On the machine that ran the import, the evidence is already local (gitignored) — no pull needed:

   ```text
   .github/bug-reports/imported/<report-id>/screenshot.png
   ```

2. On a fresh clone / another machine, this report is deduped by the committed ledger, so `npm run bugs:pull` intentionally **skips** it (it will not re-download). First read the private Firestore document `bugReports/<report-id>` in the Firebase console to get `screenshotPath` (or its `reporterHash` if you need to reconstruct the default path). Then retrieve the screenshot from Storage at that `screenshotPath`, normally `bug-reports/<reporter-hash>/<report-id>/screenshot.png` (retained ~90 days), or copy `imported/<report-id>/` from the machine that imported it.

Source report ID(s): `<report-id>`
````

Firebase keeps the reports immutable and retains them ~90 days, so the report ID stays a durable pointer to the evidence. Note the durable dedupe ledger means `bugs:pull` now **skips** an already-imported report on any checkout rather than re-materializing it (that is the point—no duplicate issues), so evidence retrieval for an imported report goes through its local `imported/<id>/` tree or Firebase directly (per the template above), not a re-pull.

For a **text-only report** (no `screenshot.png`; `report.json` carries a `captureError`), do not point readers at a screenshot that was never captured. Replace the retrieval steps with a single line noting the capture failed—e.g. "Text-only report—screenshot capture failed (`captureError` in `report.json`); no image available."—so the ticket never links a dead evidence path.

### 5. Create the issues

**Confirm before writing.** Creating GitHub issues is a public, outward-facing write. Present the deduplication map and the drafted issues to the human and get explicit approval **before** running any `gh issue create`—do not publish straight from an LLM draft, where a bad inference or a missed duplicate would become a public issue. (The scheduled task enforces this by stopping after drafting; a human running this runbook directly must pause here too.)

The GitHub MCP server token is **read-only** in this environment—`issue create` returns `403 Resource not accessible by integration`. Create issues with the `gh` CLI under the author identity instead. `gh issue create` is **not** intercepted by the `gh-pr-guard.sh` hook (only `gh pr create|merge|review|comment|edit` and `gh issue comment` are), so no author-wrapper is required.

```bash
# Resolve the author token in a checked step so a keyring miss FAILS CLOSED,
# rather than running gh issue create with an empty GH_TOKEN (which can fall
# back to another configured gh account and misattribute the issue):
author_token="$(gh auth token --user nathanjohnpayne)" \
  || { echo "no gh author token for nathanjohnpayne — aborting" >&2; exit 1; }
GH_TOKEN="$author_token" \
  gh issue create --repo nathanjohnpayne/gaycruisebingo \
  --title "<title>" --body-file <path-to-drafted-body.md> \
  --label bug --label "track:<area>" --label agent-action --label size:S \
  --assignee nathanjohnpayne
```

Use `--body-file` (not inline `--body`) for multi-line bodies to avoid shell-escaping issues. Pick labels from `gh label list`; the reports so far mapped to `bug` + a `track:*` area label + `polish` / `agent-action` / `size:*`.

### 6. Archive (and disposition failures)

For **every** source report included in a created issue, write its immutable receipt and move it to `imported/`:

```bash
node scripts/bug-reports.mjs archive <report-id> \
  https://github.com/nathanjohnpayne/gaycruisebingo/issues/<n>
```

Call it once per report. Each call also appends the import to the committed `.github/bug-reports/imported-ledger.jsonl` dedupe ledger (idempotent; it self-heals a pre-ledger import on re-archive) before moving the report to `imported/`—commit that file in step 7. If the ledger append fails, the report remains retryable in `inbox/` with its receipt instead of being moved into gitignored-only state. If the ledger already contains the report ID, `archive` only cleans up a stale local inbox when the requested issue URL matches the committed ledger receipt; a different issue URL fails before moving anything. Note that the login shell here is **zsh**, which does not word-split unquoted variables—a `for entry in "${MAP[@]}"; do set -- $entry; …` loop collapses `"<id> <n>"` into a single argument and the id fails validation (`Invalid report id`). Invoke `archive` explicitly per report, or split fields deliberately (`read -r id n <<< "$entry"`). For a report you cannot import, keep it retryable in the inbox: `npm run bugs:disposition -- <report-id> <failed|ambiguous> "<reason>"`.

### 7. Verify and clean up

Confirm every report is accounted for: each imported report has an `imported/<id>/github-issue.json` receipt, and any report you could not import stays in the inbox with a `disposition.json` (step 6)—a valid partial run leaves failed/ambiguous reports behind on purpose, so "empty inbox" is not the check; "no un-actioned report left over" is. The inbox/imported trees are gitignored, so `git status` shows nothing for them (`git check-ignore` confirms). The **one tracked artifact** an import produces is the dedupe ledger—**commit it** so dedupe is durable for the next run / a fresh clone:

```bash
git add .github/bug-reports/imported-ledger.jsonl
git commit -m "chore(bug-reports): record imported reports in the dedupe ledger"
```

Then purge the fetched deploy credentials: `scripts/op-preflight.sh --agent <agent> --purge`.

## Daily scheduled import

A local scheduled task (`import-bug-reports`, managed via this app's scheduled tasks) runs once per day. It is **approval-gated**: each run performs only the read-only half of the runbook—load credentials, pull, review, deduplicate, and draft—then presents the drafts and stops. It makes **no** GitHub writes and runs no `bugs:archive` / `bugs:disposition`; creating the issues and archiving is a human-approved follow-up (steps 5–6). This satisfies the #146 requirement of human confirmation before any GitHub write.

Scheduled runs execute in the local app environment, so they use the same credential path as an interactive session; each run starts with a fresh context, so its prompt is self-contained and points back at this runbook. If the app is closed when the task is due, it runs on next launch. Note that the pull needs a 1Password biometric unlock (step 1): an unattended run while 1Password is locked cannot pull, so the task is written to detect that, report it, and stop rather than proceed without credentials. No non-interactive credential path is configured today—if daily unattended pulls become a requirement, provision a 1Password service-account token (or an injected Firebase service-account key) and adapt step 1 accordingly.

## Privacy and retention

The screenshot preview is the reporter's consent boundary. Capture is limited to `.app`, excludes the bug-report UI, and never invokes screen sharing, so browser chrome and other applications are outside the capture. Exported metadata contains a truncated SHA-256 uid hash, never the raw uid, email address, auth token, Firebase download token, proof-media URL, or console/local-storage content.

Treat screenshots as potentially personal event data. Keep Firebase reports for at most 90 days, unless a linked issue still requires the evidence. During monthly maintenance, export anything needed for active issues. Then use the same authenticated Application Default Credential, explicit Firebase project, and private bucket from steps 1–2 to inspect interrupted intake rows:

```bash
npm run bugs:prune-pending
```

The command is dry-run by default. It scans PENDING and DELETING rows separately in bounded, document-id-ordered pages and reports `scanned`, `eligible`, `claimed`, `resumed`, `deleted`, `skippedRace`, and per-report `failed` results. It selects only intake reservations at least 90 days old whose intake or cleanup lease is expired; it never prunes a COMPLETE report. Review the JSON, confirm the project and bucket again, then apply exactly that cleanup:

```bash
npm run bugs:prune-pending -- --apply
```

The apply pass leases each row transactionally before deleting its deterministic private screenshot and deletes the document only while it still owns that lease. A completion/takeover race is skipped, concurrent cleaners cannot share ownership, a missing screenshot is harmless, and a partial failure leaves a discoverable DELETING row for a later monthly run. Any `failed` entry makes the command exit nonzero; retain the output, correct the credential or service problem, and rerun rather than deleting the document manually.

After staging cleanup, delete expired COMPLETE `bugReports` documents and their matching Storage objects through the existing authenticated admin procedure, preserving evidence still linked from an active issue. Delete imported local evidence when its issue closes or after 90 days, whichever is later. Never commit inbox/imported evidence.
