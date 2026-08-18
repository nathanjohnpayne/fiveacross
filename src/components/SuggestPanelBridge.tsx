import { useEffect } from 'react';
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
  const pending = useOpenSuggestPanelIntent();
  useEffect(() => {
    if (pending) navigate('/more');
  }, [pending, navigate]);
  return null;
}
