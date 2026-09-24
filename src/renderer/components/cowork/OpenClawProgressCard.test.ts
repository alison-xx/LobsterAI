// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { OpenClawProgressCard } from '../../../shared/cowork/progressCard';
import { ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { OpenClawProgressCardView } from './OpenClawProgressCard';
let host: HTMLDivElement, root: Root;
const card: OpenClawProgressCard = { sessionKey: 'a', revision: 1, updatedAt: Date.now(), markdown: '**Site**', steps: [{ step: 'Inspect', status: ProgressCardStepStatus.Completed }, { step: 'Build', status: ProgressCardStepStatus.InProgress }, { step: 'Test', status: ProgressCardStepStatus.Pending }] };
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (value = card, running = true) => act(() => root.render(React.createElement(OpenClawProgressCardView, { card: value, running, failed: false, busy: false, onDismiss: vi.fn() })));
test('starts expanded, reports current position rather than completed count, and preserves toggles on update', () => {
  render();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(host.textContent).toContain('2 of 3');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  act(() => toggle.click());
  render({ ...card, revision: 2 });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.textContent).toContain('Build');
});
test('stopping removes animation without falsely completing a step', () => {
  render(); expect(host.querySelector('[data-running="true"]')).not.toBeNull();
  render(card, false); expect(host.querySelector('[data-running="true"]')).toBeNull();
  expect(host.querySelectorAll('[data-status="completed"]')).toHaveLength(1);
});
test('supports note-only cards and only exposes close for explicitly completed plans', () => {
  render({ ...card, steps: undefined });
  expect(host.querySelector('li')).toBeNull();
  expect(host.querySelector('[data-dismiss]')).toBeNull();
  render({ ...card, steps: card.steps!.map(s => ({ ...s, status: ProgressCardStepStatus.Completed })) });
  expect(host.querySelector('[data-dismiss]')).not.toBeNull();
});
