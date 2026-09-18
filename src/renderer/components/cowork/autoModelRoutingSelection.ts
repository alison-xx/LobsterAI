import {
  type AutoRoutingCandidate,
  type CoworkAutoModelRoutingConfig,
  deriveAutoRoutingPolicy,
  findAutoRoutingCandidate,
  isAutoRoutingAvailable,
} from '@shared/cowork/autoModelRouting';

import type { Model } from '../../store/slices/modelSlice';
import { resolveOpenClawModelRef, toOpenClawModelRef } from '../../utils/openclawModelRef';
import { isModelAgenticBlocked } from '../ModelSelector';

/**
 * Renderer view of the models the Auto router may pick. Mirrors the main
 * process list: inaccessible (subscription-gated) and not-yet-agentic server
 * models are excluded.
 */
export function buildAutoRoutingCandidates(models: readonly Model[]): AutoRoutingCandidate[] {
  return models
    .filter(model => model.accessible !== false && !isModelAgenticBlocked(model))
    .map(model => ({
      ref: toOpenClawModelRef(model),
      name: model.name,
      supportsImage: model.supportsImage === true,
      contextWindow: model.contextWindow,
    }));
}

export interface CoworkAutoMaxAvailability {
  /** Auto needs at least two usable models to choose from. */
  autoAvailable: boolean;
  /** Concrete Max model ref, or '' when Max is not configured / not usable. */
  maxModelRef: string;
}

export function resolveCoworkAutoMaxAvailability(
  candidates: readonly AutoRoutingCandidate[],
  config: CoworkAutoModelRoutingConfig | null | undefined,
): CoworkAutoMaxAvailability {
  return {
    autoAvailable: isAutoRoutingAvailable(candidates),
    maxModelRef: findAutoRoutingCandidate(candidates, config?.maxModel)?.ref ?? '',
  };
}

/**
 * Whether the prompt input should send images through the vision path.
 * Under Max the Max model decides; under Auto an image turn routes to the
 * vision category, so it is enough that the derived vision model reads images.
 * Returns null when neither mode is active (the caller keeps its own check).
 */
export function resolveAutoMaxImageSupport(options: {
  autoSelected: boolean;
  /** The Max model when Max mode is on for this turn, else ''. */
  maxModelRef: string;
  candidates: readonly AutoRoutingCandidate[];
  config: CoworkAutoModelRoutingConfig | null | undefined;
  baseModelRef: string;
}): boolean | null {
  const { candidates } = options;
  if (options.maxModelRef) {
    return findAutoRoutingCandidate(candidates, options.maxModelRef)?.supportsImage === true;
  }
  if (!options.autoSelected) return null;
  const policy = deriveAutoRoutingPolicy({
    candidates,
    config: options.config,
    baseModelRef: options.baseModelRef,
  });
  return findAutoRoutingCandidate(candidates, policy.vision)?.supportsImage === true;
}

/** Display name for a resolved model ref, falling back to the bare model id. */
export function resolveAutoModelDisplayName(modelRef: string, models: readonly Model[]): string {
  const model = resolveOpenClawModelRef(modelRef, [...models]);
  if (model) return model.name;
  const slashIndex = modelRef.indexOf('/');
  return slashIndex >= 0 ? modelRef.slice(slashIndex + 1) : modelRef;
}
