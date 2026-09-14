import { OpenClawProviderId } from '../../shared/providers/constants';
import { evaluateServerModelRunGate, getAllServerModelMetadata, resolveAllEnabledProviderConfigs } from '../libs/claudeSettings';
import { buildProviderSelection } from '../libs/openclawConfigSync';
import type { LocalRemoteModel } from './remoteModelCatalog';

/** Reads the same enabled configurations as gateway config sync; secrets never leave this closure. */
export function listRemoteInputModels(server: { token: string | null; baseURL: string }): LocalRemoteModel[] {
  const items: LocalRemoteModel[] = [];
  for (const provider of resolveAllEnabledProviderConfigs()) {
    for (const model of provider.models) {
      const selection = buildProviderSelection({ apiKey: provider.apiKey, baseURL: provider.baseURL, modelId: model.id,
        apiType: provider.apiType, providerName: provider.providerName, authType: provider.authType,
        codingPlanEnabled: provider.codingPlanEnabled, supportsImage: model.supportsImage, modelName: model.name });
      items.push({ identity: JSON.stringify([provider.providerName, model.id]), runtimeRef: selection.primaryModel,
        source: 'custom', displayName: model.name || model.id, providerLabel: provider.providerName,
        available: true, image: model.supportsImage === true, toolCalling: true, thinking: { options: [] },
        configuration: JSON.parse(JSON.stringify({ provider, model })) });
    }
  }
  for (const model of getAllServerModelMetadata()) {
    const gate = evaluateServerModelRunGate(model.modelId);
    items.push({ identity: JSON.stringify([OpenClawProviderId.LobsteraiServer, model.modelId]),
      runtimeRef: `${OpenClawProviderId.LobsteraiServer}/${model.modelId}`, source: 'subscription',
      displayName: model.modelName || model.modelId, providerLabel: 'LobsterAI', available: Boolean(server.token) && gate.allowed,
      image: model.supportsImage === true, toolCalling: model.supportsToolCalling === true,
      thinking: model.thinkingConfig ? { options: model.thinkingConfig.options.map(option => option.level), default: model.thinkingConfig.defaultLevel } : { options: [] },
      configuration: JSON.parse(JSON.stringify({ model, server })) });
  }
  return items;
}
