// Stable app-facing entrypoint for the shared domain contract.
//
// The declarations live in a `.d.ts` sibling so the separately-rooted Cloud
// Functions TypeScript project can consume the SAME contract without asking
// its compiler to emit an app source file outside `functions/src`.
export type * from './domainTypes';
