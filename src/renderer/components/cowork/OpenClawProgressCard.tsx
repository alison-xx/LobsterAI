import './openclawProgressCard.css';

import { CheckIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, XMarkIcon } from '@heroicons/react/24/outline';
/** React port of OpenClaw v2026.8.1 ui/src/components/session-progress-card.ts (MIT).
 * Source commit ea806575e6450e4d1efdfc72c19f04be982a1b9b. Gateway state remains authoritative.
 */
import { useEffect, useId, useState } from 'react';

import type { OpenClawProgressCard as Card } from '../../../shared/cowork/progressCard';
import { ProgressCardStepStatus } from '../../../shared/cowork/progressCard';
import { i18nService } from '../../services/i18n';
import ProgressCardMarkdown from './ProgressCardMarkdown';
import { useOpenClawProgressCard } from './useOpenClawProgressCard';

const t = (key: string) => i18nService.t(key);
export function OpenClawProgressCardView({ card, running, failed, busy, onDismiss }: {
  card: Card; running: boolean; failed: boolean; busy: boolean; onDismiss: () => void;
}) {
  const steps = card.steps ?? [];
  const complete = steps.length > 0 && steps.every(s => s.status === ProgressCardStepStatus.Completed);
  const [expanded, setExpanded] = useState(!complete);
  const [now, setNow] = useState(Date.now());
  const bodyId = useId();
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const current = steps.find(s => s.status === ProgressCardStepStatus.InProgress) ?? steps.find(s => s.status === ProgressCardStepStatus.Pending) ?? steps[steps.length - 1];
  const position = current ? steps.indexOf(current) + 1 : 0;
  const minutes = Math.max(0, Math.floor((now - card.updatedAt) / 60_000));
  const updated = minutes < 1 ? t('progressCardJustNow') : minutes < 60
    ? t('progressCardMinutes').replace('{count}', String(minutes))
    : new Date(card.updatedAt).toLocaleString(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
  const outcome = failed ? t('progressCardFailed') : !running && !complete ? t('progressCardPaused') : '';
  return <section className="openclaw-progress-card" aria-label={t('progressCardTitle')}>
    <div className="openclaw-progress-card-heading">
      <button type="button" className="openclaw-progress-card-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}>
        <span className="openclaw-progress-card-title">{expanded ? t('progressCardTitle') : current?.step ?? t('progressCardTitle')}</span>
        <span className="openclaw-progress-card-meta">
          {expanded && <time dateTime={new Date(card.updatedAt).toISOString()} title={new Date(card.updatedAt).toLocaleString()}>{t('progressCardUpdated')} {updated}</time>}
          {steps.length > 0 && <span>{expanded ? ' · ' : ''}{t('progressCardPosition').replace('{total}', String(steps.length)).replace('{current}', String(position))}</span>}
          {outcome && <span> · {outcome}</span>}
        </span>
        {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {complete && <button type="button" data-dismiss aria-label={t('progressCardDismiss')} title={t('progressCardDismiss')} disabled={busy} onClick={onDismiss}><XMarkIcon /></button>}
    </div>
    {expanded && <div id={bodyId} className="openclaw-progress-card-body" tabIndex={0}>
      {card.markdown && <ProgressCardMarkdown content={card.markdown} />}
      {steps.length > 0 && <ol>{steps.map((step, i) => {
        const active = step.status === ProgressCardStepStatus.InProgress && running;
        const label = step.status === ProgressCardStepStatus.Completed ? t('coworkTodoCompleted') : active ? t('coworkTodoInProgress') : step.status === ProgressCardStepStatus.Pending ? t('coworkTodoPending') : outcome;
        return <li key={i} data-status={step.status} aria-label={`${label}: ${step.step}`}>
          <span className="openclaw-progress-card-marker" data-running={active} aria-hidden>
            {step.status === ProgressCardStepStatus.Completed ? <CheckIcon /> : active ? <span className="openclaw-progress-card-spinner" /> : <ClockIcon />}
          </span><span>{step.step}</span>
        </li>;
      })}</ol>}
    </div>}
  </section>;
}

export default function OpenClawProgressCard({ sessionId, running, failed }: { sessionId: string; running: boolean; failed: boolean }) {
  const { card, error, busy, reload, dismiss } = useOpenClawProgressCard(sessionId);
  return <>
    {card && <OpenClawProgressCardView key={card.sessionKey} card={card} running={running} failed={failed} busy={busy} onDismiss={() => void dismiss()} />}
    {error && <div className="openclaw-progress-card-error" role="status">{t('progressCardUnavailable')} <button type="button" onClick={() => void reload()}>{t('progressCardRetry')}</button></div>}
  </>;
}
