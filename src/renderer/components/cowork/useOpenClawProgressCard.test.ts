// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useOpenClawProgressCard } from './useOpenClawProgressCard';
let root: Root, host: HTMLDivElement, listener: (event: { sessionId: string }) => void;
let state: ReturnType<typeof useOpenClawProgressCard>;
const card = (revision: number) => ({ sessionKey: 'native', revision, updatedAt: 1, markdown: `Revision ${revision}` });
const get = vi.fn(), dismiss = vi.fn(), off = vi.fn();
function Probe({ id }: { id: string }) { state = useOpenClawProgressCard(id); return null; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  get.mockReset(); dismiss.mockReset(); off.mockReset();
  Object.defineProperty(window, 'electron', { configurable: true, value: { cowork: { getProgressCard: get, dismissProgressCard: dismiss, onProgressCardChanged: (fn: typeof listener) => { listener = fn; return off; } } } });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = (id: string) => act(async () => root.render(React.createElement(Probe, { id })));
test('loads saved state; ignores other sessions; updates, preserves on error, retries and clears', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  expect(state.card?.revision).toBe(1);
  await act(async () => listener({ sessionId: 'other' })); expect(get).toHaveBeenCalledTimes(1);
  get.mockResolvedValue({ success: false }); await act(async () => listener({ sessionId: 'one' }));
  expect(state.card?.revision).toBe(1); expect(state.error).toBe(true);
  get.mockResolvedValue({ success: true, card: card(2) }); await act(async () => { await state.reload(); });
  expect(state.card?.revision).toBe(2); expect(state.error).toBe(false);
  get.mockResolvedValue({ success: true, card: null }); await act(async () => listener({ sessionId: 'one' }));
  expect(state.card).toBeNull();
});
test('late reads never replace a newer event result or leak into another session', async () => {
  let resolve!: (v: unknown) => void;
  get.mockImplementationOnce(() => new Promise(r => { resolve = r; })); await render('one');
  get.mockResolvedValue({ success: true, card: card(3) }); await act(async () => listener({ sessionId: 'one' }));
  await act(async () => resolve({ success: true, card: card(1) })); expect(state.card?.revision).toBe(3);
  get.mockImplementationOnce(() => new Promise(r => { resolve = r; })); await act(async () => listener({ sessionId: 'one' }));
  get.mockResolvedValue({ success: true, card: null }); await render('two');
  await act(async () => resolve({ success: true, card: card(4) })); expect(state.card).toBeNull(); expect(off).toHaveBeenCalled();
});
test('duplicate closes are locked and a conflict returns the newer saved card', async () => {
  get.mockResolvedValue({ success: true, card: card(1) }); await render('one');
  let resolve!: (v: unknown) => void;
  dismiss.mockImplementation(() => new Promise(r => { resolve = r; }));
  let done!: Promise<void>;
  await act(async () => { done = state.dismiss(); void state.dismiss(); });
  expect(dismiss).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ success: true, card: card(2) }); await done; });
  expect(state.card?.revision).toBe(2); expect(state.busy).toBe(false);
});
