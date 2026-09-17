// This entry runs only for a legacy config field or a matching startup failure.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { importConfigMachineState, readConfigMachineState } from '#openclaw-config-machine-state';
import { createConfigIO } from '#openclaw-config-io';
import { closeOpenClawStateDatabase } from '#openclaw-state-db';
import { withLegacyMigrationStateLock } from '#openclaw-migration-lock';
import { recoverRetiredBindingColumns } from './openclaw-binding-schema-recovery.mjs';
import { resolveMemoryDreamingWorkspaces } from '#openclaw-dreaming-workspaces';
import { recoverLegacyDreamingState } from './openclaw-dreaming-state-recovery.mjs';
import { DREAMING_RECOVERY_REPORT_VERSION, OpenClawDreamingRecoveryOutcome } from '../src/shared/openclawEngine/dreamingRecovery.ts';
import {
  OPENCLAW_LEGACY_DISCOVERY_KEY,
  OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OPENCLAW_STARTUP_COMPATIBILITY_VERSION,
  OpenClawBundledDiscoveryMode,
  OpenClawStartupCompatibilityMode,
} from '../src/shared/openclawEngine/startupCompatibility.ts';
import { OpenClawStartupMigrationStatus } from '../src/shared/openclawEngine/startupMigration.ts';

const report = {
  reportVersion: DREAMING_RECOVERY_REPORT_VERSION,
  runtimeVersion: OPENCLAW_STARTUP_COMPATIBILITY_VERSION,
  operation: process.argv[2],
  status: OpenClawStartupMigrationStatus.Skipped, changes: [], backups: [],
};
const machineStateKey = `plugins.${OPENCLAW_LEGACY_DISCOVERY_KEY}`;
const isDiscoveryMode = value => Object.values(OpenClawBundledDiscoveryMode).includes(value);

async function migrateConfig({ stateDir, configPath, env }) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!Object.hasOwn(config.plugins ?? {}, OPENCLAW_LEGACY_DISCOVERY_KEY)) return [];
  const value = config.plugins[OPENCLAW_LEGACY_DISCOVERY_KEY];
  if (!isDiscoveryMode(value)) throw new Error('Legacy plugins.bundledDiscovery has an unsupported value.');
  const backupPath = `${configPath}.startup-compat-${Date.now()}-${randomUUID()}.bak`;
  fs.writeFileSync(backupPath, raw, { flag: 'wx', mode: 0o600 });
  report.backups.push(backupPath);

  // The pinned owner handles supported old schemas and keeps newer machine state.
  // Do not remove the source until the canonical value is readable and valid.
  importConfigMachineState([[machineStateKey, value]], { stateDir, env });
  if (!isDiscoveryMode(readConfigMachineState(machineStateKey, { stateDir, env }))) {
    throw new Error('Canonical bundled discovery state could not be verified.');
  }
  const io = createConfigIO({ configPath, env, pluginValidation: 'core-only', shellEnvFallback: 'defer', observe: false });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (snapshot.raw !== raw) throw new Error('OpenClaw config changed during discovery migration; retry with the latest config.');
  const next = structuredClone(config);
  delete next.plugins[OPENCLAW_LEGACY_DISCOVERY_KEY];
  await io.writeConfigFile(next, {
    ...writeOptions, baseSnapshot: snapshot, skipPluginValidation: true,
    allowConfigSizeDrop: true, skipRuntimeSnapshotRefresh: true, skipOutputLogs: true, auditOrigin: 'doctor',
  });
  const verified = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (Object.hasOwn(verified.plugins ?? {}, OPENCLAW_LEGACY_DISCOVERY_KEY)) {
    throw new Error('Legacy bundled discovery field remains after migration.');
  }
  return ['Migrated legacy bundled discovery state and removed its retired config field.'];
}

try {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const homeDir = process.env.OPENCLAW_HOME;
  const mode = process.argv[2];
  if (![stateDir, configPath, homeDir].every(value => value && path.isAbsolute(value))) {
    throw new Error('Startup compatibility requires explicit absolute OpenClaw state, config and home paths.');
  }
  const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
  if (JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')).version !== OPENCLAW_STARTUP_COMPATIBILITY_VERSION) {
    throw new Error('Startup compatibility refuses an unsupported OpenClaw runtime version.');
  }
  if (!Object.values(OpenClawStartupCompatibilityMode).includes(mode)) throw new Error('Unknown startup compatibility operation.');
  const result = await withLegacyMigrationStateLock({
    stateDir, env: process.env, label: 'startup compatibility', releaseLabel: 'Startup compatibility',
    retryGuidance: 'Stop the gateway before retrying startup or Quick Repair.',
    beforeRelease: () => closeOpenClawStateDatabase(),
    run: async env => {
      if (mode === OpenClawStartupCompatibilityMode.RepairBindings) {
        const change = await recoverRetiredBindingColumns({ stateDir, env, backups: report.backups });
        if (change) report.changes.push(change);
      } else if (mode === OpenClawStartupCompatibilityMode.RepairDreamingState) {
        const configRaw = fs.readFileSync(configPath);
        const config = JSON.parse(configRaw.toString('utf8'));
        const workspaces = resolveMemoryDreamingWorkspaces(config, { env });
        report.dreaming = await recoverLegacyDreamingState({ stateDir, configPath, configRaw, workspaces });
        report.backups.push(...report.dreaming.files.map(file => file.backupPath));
        if (report.dreaming.outcome === OpenClawDreamingRecoveryOutcome.Blocked) {
          throw new Error(report.dreaming.blockers.join('\n'));
        }
        if (report.dreaming.outcome === OpenClawDreamingRecoveryOutcome.Recovered) {
          report.changes.push(`Backed up and isolated ${report.dreaming.files.length} invalid legacy Memory Core JSON files.`);
        }
      } else {
        report.changes.push(...await migrateConfig({ stateDir, configPath, env }));
      }
      return { changes: [], warnings: [] };
    },
  });
  if (result.warnings.length) throw new Error(result.warnings.join('\n'));
  report.status = report.changes.length ? OpenClawStartupMigrationStatus.Migrated : OpenClawStartupMigrationStatus.Skipped;
} catch (error) {
  report.status = OpenClawStartupMigrationStatus.Failed;
  report.error = error instanceof Error ? error.message : String(error);
}
console.log(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX + JSON.stringify(report));
process.exitCode = report.status === OpenClawStartupMigrationStatus.Failed ? 1 : 0;
