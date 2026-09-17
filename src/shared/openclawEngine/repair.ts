export const OPENCLAW_REPAIR_ENTRY = 'openclaw-gateway-repair.mjs';
export const OPENCLAW_REPAIR_RESULT_PREFIX = 'LOBSTERAI_GATEWAY_REPAIR_RESULT=';

export const OpenClawRepairPhase = {
  Snapshot: 'snapshot',
  Recovery: 'recovery',
  Plugins: 'plugins',
} as const;
export type OpenClawRepairPhase = typeof OpenClawRepairPhase[keyof typeof OpenClawRepairPhase];

export const OpenClawRepairPluginSource = {
  Npm: 'npm',
  Path: 'path',
} as const;

export interface OpenClawCompatibilityRepairReport {
  phase: OpenClawRepairPhase;
  success: boolean;
  changes: string[];
  backups: string[];
  error?: string;
}
