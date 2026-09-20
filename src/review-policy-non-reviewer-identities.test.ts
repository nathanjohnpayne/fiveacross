import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Pins this repo's adoption of the `non_reviewer_identities` deny-list (#1026,
// machinery from mergepath#1080). `scripts/merge-clearance-gate.sh` runs the
// check on every lane, but the declaration is per-repo-owned and deliberately
// not propagated, so the gate is inert here until `.github/review-policy.yml`
// carries the key. Nothing else in this tree fails when the key is deleted —
// the gate reads an absent key as the legitimate "no such identity here"
// configuration and passes — so this suite is the only thing standing between
// a silent revert and a CI token that can satisfy branch protection again.
//
// Reading the file as text rather than parsing it is deliberate: the SHAPE of
// the value is load-bearing. A YAML flow list (`[nathanpayne-robot]`) parses to
// the same structure the gate's block reader cannot consume, and the gate
// exits 2 on it rather than running.

const readRepoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// Body of a top-level YAML block list, up to the next top-level key. Returns
// null when the key is absent so a caller can tell "no key" from "empty body".
const blockListBody = (yaml: string, key: string): string | null => {
  const match = yaml.match(new RegExp(`\\n${key}:\\n([\\s\\S]*?)\\n[^\\s#]`));
  return match ? match[1] : null;
};

const entries = (body: string): string[] =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim().replace(/^["']|["']$/g, ''));

describe('review-policy.yml non_reviewer_identities (#1026)', () => {
  const policy = readRepoFile('../.github/review-policy.yml');

  // Positive control FIRST. Every assertion below rests on `blockListBody`
  // still matching the file's formatting; a reader that has quietly stopped
  // matching returns null for everything, and "the deny-list does not contain
  // a bot" is a pass that proves nothing.
  it('the block reader still finds a list this file is known to carry', () => {
    const reviewers = blockListBody(policy, 'available_reviewers');
    expect(reviewers).not.toBeNull();
    expect(entries(reviewers as string)).toContain('nathanpayne-codex');
  });

  it('declares the CI service account a non-reviewer', () => {
    const body = blockListBody(policy, 'non_reviewer_identities');
    expect(body).not.toBeNull();
    expect(entries(body as string)).toContain('nathanpayne-robot');
  });

  it('uses the dash-prefixed block form the gate can parse, not a flow list', () => {
    // A non-empty inline value exits the gate 2 instead of running it, because
    // that shape is indistinguishable from an absent key to the block reader.
    expect(policy).not.toMatch(/^non_reviewer_identities:[ \t]*\[[ \t]*[^\]\s]/m);
    expect(policy).toMatch(/^non_reviewer_identities:[ \t]*$/m);
  });

  it('does not deny an account that also holds reviewer standing', () => {
    const denied = entries(blockListBody(policy, 'non_reviewer_identities') as string);
    const reviewers = entries(blockListBody(policy, 'available_reviewers') as string);
    expect(denied.filter((login) => reviewers.includes(login))).toEqual([]);
  });

  it('does not deny the review-provider App bots Phase 2.5 and Phase 4a depend on', () => {
    const denied = entries(blockListBody(policy, 'non_reviewer_identities') as string);
    expect(denied).not.toContain('coderabbitai[bot]');
    expect(denied).not.toContain('chatgpt-codex-connector[bot]');
  });

  it('REVIEW_POLICY.md carries the section the gate block message sends operators to', () => {
    // merge-clearance-gate.sh blocks with "(see REVIEW_POLICY.md,
    // non_reviewer_identities)". That pointer has to resolve.
    const doc = readRepoFile('../REVIEW_POLICY.md');
    expect(doc).toMatch(/^### Non-reviewer identities$/m);
    expect(doc).toMatch(/non_reviewer_identities/);
  });
});
