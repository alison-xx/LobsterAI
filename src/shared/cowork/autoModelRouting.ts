/**
 * Cowork "Auto" and "Max" model modes.
 *
 * - Auto: a per-session choice stored as the reserved sentinel
 *   {@link COWORK_AUTO_MODEL_REF} in `session.modelOverride`. The main process
 *   classifies every turn (vision / long context / code / general) and resolves
 *   the sentinel to a concrete model for that turn only; the stored selection
 *   stays Auto and the sentinel is never sent to the gateway.
 * - Max: a per-session flag (`cowork_sessions.max_mode`) that overlays the
 *   current selection with the model the user configured as "Max". Turning it
 *   off restores the previous selection because the selection is never touched.
 *
 * The routing policy is derived locally from the models the user can actually
 * use, plus optional per-category overrides stored in the Cowork config. This
 * module is pure so the main process and the renderer derive the same policy.
 */

/** Reserved model ref that marks a Cowork session as using Auto routing. */
export const COWORK_AUTO_MODEL_REF = 'lobsterai/__auto__';

const COWORK_AUTO_MODEL_REF_LOWER = COWORK_AUTO_MODEL_REF.toLowerCase();

/** Whether a model ref is the Auto sentinel (case-insensitive, trimmed). */
export function isAutoModelRef(ref: string | null | undefined): boolean {
  return (ref ?? '').trim().toLowerCase() === COWORK_AUTO_MODEL_REF_LOWER;
}

/** Task categories, ordered by classification precedence (Vision first). */
export const AutoModelCategory = {
  Vision: 'vision',
  LongContext: 'longContext',
  Code: 'code',
  General: 'general',
} as const;
export type AutoModelCategory = typeof AutoModelCategory[keyof typeof AutoModelCategory];

/** Why a turn ran on a model other than the stored selection. */
export const AutoModelResolveReason = {
  Auto: 'auto',
  Max: 'max',
} as const;
export type AutoModelResolveReason = typeof AutoModelResolveReason[keyof typeof AutoModelResolveReason];

/** Payload of the display-only "this turn ran on <model>" event. */
export interface CoworkAutoModelResolvedEvent {
  sessionId: string;
  modelRef: string;
  reason: AutoModelResolveReason;
  category?: AutoModelCategory;
}

/**
 * User overrides for Auto/Max, stored in the Cowork config. Every value is an
 * OpenClaw model ref (`provider/model`); an empty string means "derive
 * automatically" (or, for `maxModel`, "Max is not configured").
 */
export interface CoworkAutoModelRoutingConfig {
  generalModel: string;
  codeModel: string;
  visionModel: string;
  longContextModel: string;
  maxModel: string;
}

export const DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG: CoworkAutoModelRoutingConfig = {
  generalModel: '',
  codeModel: '',
  visionModel: '',
  longContextModel: '',
  maxModel: '',
};

const AUTO_MODEL_ROUTING_CONFIG_KEYS = [
  'generalModel',
  'codeModel',
  'visionModel',
  'longContextModel',
  'maxModel',
] as const satisfies ReadonlyArray<keyof CoworkAutoModelRoutingConfig>;

/** Normalize untrusted input (IPC payloads, persisted JSON) into a config. */
export function normalizeAutoModelRoutingConfig(input: unknown): CoworkAutoModelRoutingConfig {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const config = { ...DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG };
  for (const key of AUTO_MODEL_ROUTING_CONFIG_KEYS) {
    const value = raw[key];
    config[key] = typeof value === 'string' ? value.trim() : '';
  }
  return config;
}

export function isSameAutoModelRoutingConfig(
  a: CoworkAutoModelRoutingConfig | null | undefined,
  b: CoworkAutoModelRoutingConfig | null | undefined,
): boolean {
  const left = normalizeAutoModelRoutingConfig(a);
  const right = normalizeAutoModelRoutingConfig(b);
  return AUTO_MODEL_ROUTING_CONFIG_KEYS.every(key => left[key] === right[key]);
}

/** A model the user can actually run, as seen by the Auto router. */
export interface AutoRoutingCandidate {
  /** OpenClaw model ref, e.g. `anthropic/claude-sonnet-4`. */
  ref: string;
  /** Display name. */
  name: string;
  supportsImage?: boolean;
  /** Context window in tokens, when known. */
  contextWindow?: number;
}

/**
 * Concrete model refs per category. An empty string means the category has no
 * dedicated model and the turn runs on {@link AutoRoutingPolicy.general}.
 */
export interface AutoRoutingPolicy {
  general: string;
  code: string;
  vision: string;
  longContext: string;
  /** Model used by Max mode; empty when Max is not available. */
  max: string;
}

/** Auto only makes sense when there is more than one model to choose from. */
export const AUTO_ROUTING_MIN_CANDIDATES = 2;

export function isAutoRoutingAvailable(candidates: readonly AutoRoutingCandidate[]): boolean {
  return candidates.length >= AUTO_ROUTING_MIN_CANDIDATES;
}

const splitModelRef = (ref: string): { providerId: string; modelId: string } => {
  const trimmed = ref.trim();
  const slashIndex = trimmed.indexOf('/');
  return slashIndex >= 0
    ? { providerId: trimmed.slice(0, slashIndex), modelId: trimmed.slice(slashIndex + 1) }
    : { providerId: '', modelId: trimmed };
};

/**
 * Find the candidate for a model ref: exact ref match first (provider id is
 * compared case-insensitively), then a unique match on the bare model id.
 */
export function findAutoRoutingCandidate(
  candidates: readonly AutoRoutingCandidate[],
  ref: string | null | undefined,
): AutoRoutingCandidate | null {
  const normalized = (ref ?? '').trim();
  if (!normalized || isAutoModelRef(normalized)) return null;
  const target = splitModelRef(normalized);
  const exact = candidates.find((candidate) => {
    const parts = splitModelRef(candidate.ref);
    return parts.modelId === target.modelId
      && parts.providerId.toLowerCase() === target.providerId.toLowerCase();
  });
  if (exact) return exact;
  const byId = candidates.filter(candidate => splitModelRef(candidate.ref).modelId === target.modelId);
  return byId.length === 1 ? byId[0] : null;
}

/** Resolve the Max model, or '' when Max is not configured or not usable. */
export function resolveMaxModelRef(
  candidates: readonly AutoRoutingCandidate[],
  config: CoworkAutoModelRoutingConfig | null | undefined,
): string {
  return findAutoRoutingCandidate(candidates, config?.maxModel)?.ref ?? '';
}

const pickPreferred = (
  candidates: readonly AutoRoutingCandidate[],
  predicate: (candidate: AutoRoutingCandidate) => boolean,
  preferredProviderId: string,
): AutoRoutingCandidate | null => {
  const matches = candidates.filter(predicate);
  if (matches.length === 0) return null;
  const sameProvider = preferredProviderId
    ? matches.find(candidate => (
      splitModelRef(candidate.ref).providerId.toLowerCase() === preferredProviderId.toLowerCase()
    ))
    : undefined;
  return sameProvider ?? matches[0];
};

/**
 * Derive the per-category routing policy.
 *
 * Rules (an override always wins when it names a usable candidate; overrides
 * that no longer match a usable model are ignored):
 * - general: the general override, else `baseModelRef` (the session/agent model).
 * - code: the code override, else general. Code-specialised models are not
 *   guessed from names.
 * - vision: the vision override; else general when it reads images; else the
 *   first image-capable candidate (same provider as general preferred); else general.
 * - longContext: the long-context override; else the candidate with the
 *   largest known context window, but only when it is strictly larger than the
 *   general model's known window; else general.
 * - max: the Max override only. Max is never derived.
 */
export function deriveAutoRoutingPolicy(options: {
  candidates: readonly AutoRoutingCandidate[];
  config?: CoworkAutoModelRoutingConfig | null;
  baseModelRef?: string;
}): AutoRoutingPolicy {
  const { candidates } = options;
  const config = options.config ?? DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG;
  const override = (ref: string): string => findAutoRoutingCandidate(candidates, ref)?.ref ?? '';

  const baseModelRef = isAutoModelRef(options.baseModelRef) ? '' : (options.baseModelRef ?? '').trim();
  const general = override(config.generalModel) || baseModelRef;
  const generalCandidate = findAutoRoutingCandidate(candidates, general);
  const generalProviderId = splitModelRef(general).providerId;

  const code = override(config.codeModel) || general;

  let vision = override(config.visionModel);
  if (!vision) {
    vision = generalCandidate?.supportsImage
      ? general
      : pickPreferred(candidates, candidate => candidate.supportsImage === true, generalProviderId)?.ref
        ?? general;
  }

  let longContext = override(config.longContextModel);
  if (!longContext) {
    const generalWindow = generalCandidate?.contextWindow ?? 0;
    const largest = generalWindow > 0
      ? candidates.reduce<AutoRoutingCandidate | null>((best, candidate) => {
        const window = candidate.contextWindow ?? 0;
        if (window <= generalWindow) return best;
        return !best || window > (best.contextWindow ?? 0) ? candidate : best;
      }, null)
      : null;
    longContext = largest?.ref ?? general;
  }

  return {
    general,
    code,
    vision,
    longContext,
    max: resolveMaxModelRef(candidates, config),
  };
}

/** The model ref a policy assigns to a category, falling back to general. */
export function selectAutoRoutingModelRef(policy: AutoRoutingPolicy, category: AutoModelCategory): string {
  switch (category) {
    case AutoModelCategory.Vision:
      return policy.vision || policy.general;
    case AutoModelCategory.LongContext:
      return policy.longContext || policy.general;
    case AutoModelCategory.Code:
      return policy.code || policy.general;
    case AutoModelCategory.General:
    default:
      return policy.general;
  }
}
