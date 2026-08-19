import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useOpenSuggestPanelIntent } from '../hooks/useOpenSuggestPanel';

/**
 * The navigation half of the Card/Feed → More "Suggest a square" bridge
 * (#559, src/hooks/useOpenSuggestPanel.ts). Mounted once from App.tsx,
 * alongside `<Nav />` — both are always inside the Router regardless of
 * which tab is active, unlike `Board.tsx`, which is deliberately kept
 * react-router-free (many of its unit tests mount it standalone with no
 * `<Router>` wrapper). The Card and Feed invitations
 * (`TomorrowsCardInvite.tsx`) only call `requestOpenSuggestPanel()`; THIS
 * component is what actually navigates to `/more` once that intent lands —
 * `More.tsx`, once mounted there, consumes the SAME intent to open its
 * Suggest panel. Renders nothing.
 */
export default function SuggestPanelBridge() {
  const navigate = useNavigate();
  // Read through a "latest ref" (the same pattern ProofSheet.tsx's onClose
  // uses), so the navigation effect below does not depend on `navigate`'s
  // own identity (Codex P1, PR #845, round 4): under `BrowserRouter`,
  // `useNavigate()` returns a NEW function once the pathname changes, so a
  // dependency on it would re-run the effect the instant the `/more` push
  // lands — while `pending` is often still `true` (`More.tsx` clears it in
  // its OWN effect, which may not have committed yet) — pushing a SECOND
  // `/more` history entry and leaving the first Back tap stranded on More
  // instead of returning to the tab the Player actually came from.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  const pending = useOpenSuggestPanelIntent();
  useEffect(() => {
    if (pending) navigateRef.current('/more');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `navigate` is read through the ref above (kept current every render), so this effect fires exactly once per false→true `pending` transition — never again on a route-change-driven identity churn while `pending` stays true. See the doc comment.
  }, [pending]);
  return null;
}
