# PostHog error tracking—rate limits and alert routing

Runbook for the PostHog error-tracking configuration on project `GayCruiseBingo.com` (id 503790). All of it is PostHog-side project config, not application code—nothing here is changed by editing this repo or redeploying. The sibling record for the personal-site project lives in [`nathanjohnpayne/nathanpaynedotcom`](https://github.com/nathanjohnpayne/nathanpaynedotcom); the two are configured identically apart from the target repo.

Exception autocapture is on, so unhandled errors and unhandled promise rejections are captured without an explicit `captureException` call. `src/components/ErrorBoundary.tsx` deliberately does not re-report the raw throw for that reason.

## Rate limits

| Setting | Value |
|---|---|
| `project_rate_limit_value` | 1000 |
| `project_rate_limit_bucket_size_minutes` | 60 |
| `per_issue_rate_limit_value` | 250 |
| `per_issue_rate_limit_bucket_size_minutes` | 60 |

These are a runaway-loop backstop, not a volume control, and the numbers are deliberately far above anything this project has produced. The measured baseline over 90 days was 39 `$exception` events across 14 issues—worst day 14, worst minute 10, noisiest single issue 11 over its entire lifetime. The caps sit roughly 70x and 23x above those figures, so a genuine incident is never clipped; only an unbounded loop trips them.

The realistic runaway here is not a render loop, which `ErrorBoundary` already bounds, but unhandled promise rejections from Firestore listeners retrying on a shipboard network, multiplied across many clients at once. A `FirebaseError` issue already exists in the list, so this is a live shape rather than a hypothetical one.

If exceptions ever look silently missing during a wide-blast incident, check these caps first—a genuinely large event could reach 250 per issue per hour. Raise the ceiling rather than removing it, and do not tighten the buckets below 60 minutes: a short bucket with a low ceiling clips legitimate spikes, which is the failure mode worth avoiding given how rarely this project throws at all.

Read and write the values with the project-scoped PostHog MCP server:

```text
call error-tracking-settings-get
call error-tracking-settings-update {"project_rate_limit_value":1000,"project_rate_limit_bucket_size_minutes":60,"per_issue_rate_limit_value":250,"per_issue_rate_limit_bucket_size_minutes":60}
```

Trust that read, not the in-app recommendation card. After a successful write, `error-tracking-recommendations-list` continued to report `rate_limits: {project: false, per_issue: false}` with `status: computing` for well over ten minutes, while `error-tracking-settings-get` returned the new values immediately. The `alerts` recommendation, by contrast, flips within seconds.

## Alert routing

Two alerts file GitHub issues into `nathanjohnpayne/gaycruisebingo`, through PostHog integration 202688 (`github`, `nathanjohnpayne`).

| Alert | Trigger event | Issue title shape |
|---|---|---|
| `Issue created · gaycruisebingo (auto)` | `$error_tracking_issue_created` | `[error-tracking] <name>` |
| `Issue reopened · gaycruisebingo (auto)` | `$error_tracking_issue_reopened` | `[error-tracking] Regression: <name>` |

`$error_tracking_issue_spiking` is deliberately not wired. It re-fires on issues that already exist, so pointing it at an issue tracker files duplicate tickets for issues already open; it is additionally silent until spike detection is configured, and at this volume the detector would rarely trip. Spiking is a chat-channel trigger, not an issue-tracker one.

## Gotchas

**PostHog GitHub integrations are per-project.** The PostHog GitHub App is installed once org-wide on `nathanjohnpayne` with All-repositories access, but each PostHog project needs its own integration record, created by connecting from the Settings then Integrations page belonging to that project. Reinstalling or re-authorizing the App does nothing for a second project—`integrations-list` on the unconnected project keeps returning `count: 0` until someone clicks Connect there.

**`template-github` requires `posthog_issue_id` on create**, even though its schema marks the field `hidden: true` with a default. Omitting it fails validation with `This field is required`.

**The stock title and description defaults do not survive every trigger.** They reference `event.properties.$exception_types[1]` and `event.properties.$exception_values[1]`, which are only spread onto the `created` and `reopened` events; the spiking event carries neither. An alert built from the defaults therefore files empty-titled issues on that trigger. Both alerts here use `event.properties.name`, `event.properties.description`, and `event.distinct_id` instead, all of which exist on all three triggers, so the configuration stays correct if spiking is ever added.

**The recommendation cards measure configuration, not risk.** The "Rate limits—0 / 2 configured" card that prompted this work is a completeness nudge: `error-tracking-recommendations-list` returns it as `type: rate_limits` with both keys false purely because nothing was set, regardless of whether the project has any exception volume worth limiting. Read the card as a checklist item, not as evidence of a problem.
