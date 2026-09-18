import {
  AutoModelCategory,
  AutoModelResolveReason,
  type AutoRoutingCandidate,
  type CoworkAutoModelRoutingConfig,
  deriveAutoRoutingPolicy,
  selectAutoRoutingModelRef,
} from '../../../shared/cowork/autoModelRouting';

/**
 * Heuristic per-turn model router for Cowork Auto/Max modes. Everything here
 * is pure: classification uses only the turn input, so it adds no model call,
 * no latency and no token cost.
 */

/** Input observed for a single turn, used to pick a category. */
export interface AutoClassifyInput {
  /** The user prompt text for the turn. */
  prompt?: string;
  /** Number of image attachments on the turn. */
  imageAttachmentCount?: number;
  /** Extra context text (e.g. selected snippets) folded into the estimate. */
  contextText?: string;
}

/**
 * Long-context threshold. A rough char→token estimate (chars / 3.5) that
 * crosses ~6k tokens routes the turn to a large-window model.
 */
export const AUTO_LONG_CONTEXT_TOKEN_THRESHOLD = 6000;
const CHARS_PER_TOKEN = 3.5;

/** Fenced code blocks. */
const CODE_FENCE_PATTERN = /```/;
/** Source file references by extension. */
const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|rb|php|swift|scala|sql|sh|bash|zsh|json|ya?ml|toml|html?|css|scss|vue|svelte)\b/i;
/** Common code keywords / constructs. */
const CODE_KEYWORD_PATTERN = /\b(function|class|import|export|def|return|const|let|var|public|private|interface|struct|async|await|SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b|=>|::|<\/?[a-z][^>]*>/;

function looksLikeCode(text: string): boolean {
  if (!text) return false;
  return CODE_FENCE_PATTERN.test(text)
    || CODE_FILE_PATTERN.test(text)
    || CODE_KEYWORD_PATTERN.test(text);
}

/**
 * Classify a turn into a task category. Precedence is a hard constraint:
 * Vision > LongContext > Code > General.
 */
export function classifyTaskCategory(input: AutoClassifyInput): AutoModelCategory {
  if ((input.imageAttachmentCount ?? 0) > 0) {
    return AutoModelCategory.Vision;
  }

  const prompt = input.prompt ?? '';
  const contextText = input.contextText ?? '';
  if ((prompt.length + contextText.length) / CHARS_PER_TOKEN >= AUTO_LONG_CONTEXT_TOKEN_THRESHOLD) {
    return AutoModelCategory.LongContext;
  }

  if (looksLikeCode(prompt) || looksLikeCode(contextText)) {
    return AutoModelCategory.Code;
  }

  return AutoModelCategory.General;
}

/** Local routing inputs supplied by the main process. */
export interface AutoModelRoutingSource {
  /** Models the user can run right now. */
  candidates: AutoRoutingCandidate[];
  /** Optional per-category overrides from the Cowork config. */
  config: CoworkAutoModelRoutingConfig;
}

/** The concrete model a turn resolved to under Auto/Max. */
export interface AutoTurnModelResolution {
  modelRef: string;
  reason: AutoModelResolveReason;
  /** Set for Auto turns only. */
  category?: AutoModelCategory;
}

/**
 * Resolve the model for one turn.
 *
 * - Max wins when enabled and a Max model is configured and usable; otherwise
 *   Max is ignored and the session behaves as it would without it.
 * - Auto (the stored selection is the sentinel) classifies the turn and picks
 *   the category model, falling back to `baseModelRef` (the agent model).
 * - Returns null when neither applies, so the caller keeps its normal path.
 */
export function resolveAutoTurnModel(options: {
  input: AutoClassifyInput;
  source: AutoModelRoutingSource | null | undefined;
  /** Concrete model the session would use without Auto/Max. */
  baseModelRef: string;
  autoSelected: boolean;
  maxMode: boolean;
}): AutoTurnModelResolution | null {
  const { source, autoSelected, maxMode } = options;
  if (!autoSelected && !maxMode) return null;

  const policy = deriveAutoRoutingPolicy({
    candidates: source?.candidates ?? [],
    config: source?.config,
    baseModelRef: options.baseModelRef,
  });

  if (maxMode && policy.max) {
    return { modelRef: policy.max, reason: AutoModelResolveReason.Max };
  }
  if (!autoSelected) return null;

  const category = classifyTaskCategory(options.input);
  const modelRef = selectAutoRoutingModelRef(policy, category) || options.baseModelRef.trim();
  if (!modelRef) return null;
  return { modelRef, reason: AutoModelResolveReason.Auto, category };
}
