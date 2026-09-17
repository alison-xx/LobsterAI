import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase, OpenClawGatewayRepairErrorCode } from '../../shared/openclawEngine/constants';
import { store } from '../store';
import type { OpenClawGatewayRepairResult } from '../types/cowork';
import { coworkService } from './cowork';

const isRepairing = () => store.getState().cowork.isRepairingOpenClaw;

const mockRepair = (repairGatewayState: () => Promise<OpenClawGatewayRepairResult | undefined>) => {
  vi.stubGlobal('window', {
    electron: {
      openclaw: {
        engine: {
          repairGatewayState,
          getStatus: vi.fn(async () => ({
            success: true,
            status: { phase: OpenClawEnginePhase.Running },
          })),
        },
      },
    },
  });
};

afterEach(() => {
  expect(isRepairing()).toBe(false);
  coworkService.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('keeps repair globally active across view changes and gateway status updates until the result arrives', async () => {
  let finishRepair!: (result: OpenClawGatewayRepairResult) => void;
  const repairGatewayState = vi.fn(() => new Promise<OpenClawGatewayRepairResult>((resolve) => {
    finishRepair = resolve;
  }));
  mockRepair(repairGatewayState);

  const repair = coworkService.repairOpenClawGatewayState();
  expect(isRepairing()).toBe(true);
  await coworkService.getOpenClawEngineStatus();
  expect(isRepairing()).toBe(true);

  coworkService.clearSession();
  expect(isRepairing()).toBe(true);
  const secondRepair = coworkService.repairOpenClawGatewayState();
  expect(repairGatewayState).toHaveBeenCalledTimes(1);

  const result = { success: true };
  finishRepair(result);
  await expect(repair).resolves.toEqual(result);
  await expect(secondRepair).resolves.toEqual(result);
  expect(isRepairing()).toBe(false);
});

test('releases the global loading state after repair failure and permits retry', async () => {
  const result = { success: false, errorCode: OpenClawGatewayRepairErrorCode.Busy };
  const repairGatewayState = vi.fn().mockResolvedValueOnce(result).mockResolvedValueOnce({ success: true });
  mockRepair(repairGatewayState);

  await expect(coworkService.repairOpenClawGatewayState()).resolves.toEqual(result);
  expect(isRepairing()).toBe(false);
  await expect(coworkService.repairOpenClawGatewayState()).resolves.toEqual({ success: true });
  expect(repairGatewayState).toHaveBeenCalledTimes(2);
});

test('releases the global loading state when repair IPC rejects', async () => {
  mockRepair(vi.fn().mockRejectedValue(new Error('IPC disconnected')));

  await expect(coworkService.repairOpenClawGatewayState()).rejects.toThrow('IPC disconnected');
});

test('releases the global loading state when repair IPC throws synchronously', async () => {
  mockRepair(() => { throw new Error('IPC unavailable'); });

  await expect(coworkService.repairOpenClawGatewayState()).rejects.toThrow('IPC unavailable');
});

test('does not leave the app blocked when repair returns no result', async () => {
  mockRepair(vi.fn().mockResolvedValue(undefined));

  await expect(coworkService.repairOpenClawGatewayState()).resolves.toMatchObject({ success: false });
});

test('does not enter global loading when the repair API is unavailable', async () => {
  vi.stubGlobal('window', { electron: {} });

  await expect(coworkService.repairOpenClawGatewayState()).resolves.toMatchObject({ success: false });
});
