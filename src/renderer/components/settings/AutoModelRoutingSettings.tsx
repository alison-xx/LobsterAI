import { BoltIcon, SparklesIcon } from '@heroicons/react/24/outline';
import {
  type CoworkAutoModelRoutingConfig,
  findAutoRoutingCandidate,
  isAutoRoutingAvailable,
} from '@shared/cowork/autoModelRouting';
import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import { buildAutoRoutingCandidates } from '../cowork/autoModelRoutingSelection';

interface AutoModelRoutingSettingsProps {
  value: CoworkAutoModelRoutingConfig;
  onChange: (value: CoworkAutoModelRoutingConfig) => void;
}

type RoutingField = keyof CoworkAutoModelRoutingConfig;

const AUTO_CATEGORY_FIELDS: ReadonlyArray<{ field: RoutingField; labelKey: string }> = [
  { field: 'generalModel', labelKey: 'coworkAutoRoutingGeneral' },
  { field: 'codeModel', labelKey: 'coworkAutoRoutingCode' },
  { field: 'visionModel', labelKey: 'coworkAutoRoutingVision' },
  { field: 'longContextModel', labelKey: 'coworkAutoRoutingLongContext' },
];

/**
 * Optional overrides for the Cowork Auto/Max model modes. Every field defaults
 * to "automatic"; Max stays hidden in the model selector until a Max model is
 * chosen here.
 */
const AutoModelRoutingSettings: React.FC<AutoModelRoutingSettingsProps> = ({ value, onChange }) => {
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const candidates = useMemo(() => buildAutoRoutingCandidates(availableModels), [availableModels]);
  const autoAvailable = isAutoRoutingAvailable(candidates);

  const renderSelect = (field: RoutingField, emptyLabel: string) => {
    const current = value[field];
    const stale = current && !findAutoRoutingCandidate(candidates, current);
    return (
      <select
        value={current}
        onChange={(event) => onChange({ ...value, [field]: event.target.value })}
        className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground sm:w-64"
      >
        <option value="">{emptyLabel}</option>
        {stale && (
          <option value={current}>
            {i18nService.t('coworkAutoRoutingUnavailableModel').replace('{model}', current)}
          </option>
        )}
        {candidates.map(candidate => (
          <option key={candidate.ref} value={candidate.ref}>{candidate.name}</option>
        ))}
      </select>
    );
  };

  const renderRow = (label: string, control: React.ReactNode) => (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-foreground">{label}</span>
      {control}
    </div>
  );

  return (
    <section className="space-y-3">
      <h4 className="text-sm font-medium text-foreground">
        {i18nService.t('coworkAutoRoutingTitle')}
      </h4>

      <div className="overflow-hidden rounded-xl border border-border bg-surface divide-y divide-border">
        <div className="flex items-start gap-3 p-4">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
            <SparklesIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium text-foreground">{i18nService.t('coworkModelAutoName')}</div>
            <p className="text-xs leading-5 text-secondary">{i18nService.t('coworkAutoRoutingDescription')}</p>
            {!autoAvailable && (
              <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">
                {i18nService.t('coworkAutoRoutingNeedsModels')}
              </p>
            )}
          </div>
        </div>
        {AUTO_CATEGORY_FIELDS.map(({ field, labelKey }) => (
          <React.Fragment key={field}>
            {renderRow(i18nService.t(labelKey), renderSelect(field, i18nService.t('coworkAutoRoutingAutomatic')))}
          </React.Fragment>
        ))}

        <div className="flex items-start gap-3 p-4">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
            <BoltIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium text-foreground">{i18nService.t('coworkModelMaxName')}</div>
            <p className="text-xs leading-5 text-secondary">{i18nService.t('coworkAutoRoutingMaxDescription')}</p>
          </div>
        </div>
        {renderRow(
          i18nService.t('coworkAutoRoutingMaxModel'),
          renderSelect('maxModel', i18nService.t('coworkAutoRoutingMaxOff')),
        )}
      </div>
    </section>
  );
};

export default AutoModelRoutingSettings;
