import { useCallback, useEffect, useRef, useState } from 'react';

import type { OpenClawProgressCard, ProgressCardResponse } from '../../../shared/cowork/progressCard';

export function useOpenClawProgressCard(sessionId: string) {
  const [card, setCard] = useState<OpenClawProgressCard | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const dismissing = useRef(false);
  const run = useCallback(async (request: () => Promise<ProgressCardResponse>) => {
    const version = ++sequence.current;
    try {
      const result = await request();
      if (version !== sequence.current) return;
      if (!result.success || result.card === undefined) throw new Error('Unavailable');
      setCard(result.card); setError(false);
    } catch { if (version === sequence.current) setError(true); }
  }, []);
  const reload = useCallback(() => run(() => window.electron.cowork.getProgressCard(sessionId)), [sessionId, run]);
  useEffect(() => {
    const requestSequence = sequence;
    setCard(null); setError(false);
    const off = window.electron.cowork.onProgressCardChanged(event => {
      if (event.sessionId === sessionId) void reload();
    });
    void reload();
    return () => { ++requestSequence.current; off(); };
  }, [sessionId, reload]);
  const dismiss = useCallback(async () => {
    if (!card || dismissing.current) return;
    dismissing.current = true; setBusy(true);
    try { await run(() => window.electron.cowork.dismissProgressCard(sessionId, card.revision)); }
    finally { dismissing.current = false; setBusy(false); }
  }, [card, sessionId, run]);
  return { card, error, busy, reload, dismiss };
}
