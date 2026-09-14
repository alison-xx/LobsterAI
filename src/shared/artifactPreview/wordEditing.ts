export const WordFileIpc = {
  Open: 'artifact:word:open',
  Read: 'artifact:word:read',
  Checkpoint: 'artifact:word:checkpoint',
  Save: 'artifact:word:save',
  DiscardDraft: 'artifact:word:discard-draft',
  Release: 'artifact:word:release',
  Changed: 'artifact:word:changed',
  SetUnsafeEdits: 'artifact:word:set-unsafe-edits',
} as const;

export const WordFileError = {
  InvalidFile: 'invalid-file',
  TooLarge: 'too-large',
  Unsupported: 'unsupported',
  Conflict: 'conflict',
  Forbidden: 'forbidden',
  Io: 'io',
} as const;
export type WordFileError = typeof WordFileError[keyof typeof WordFileError];

export const WORD_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const WORD_MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const WORD_MAX_PART_BYTES = 25 * 1024 * 1024;
export const WORD_MAX_PARTS = 4096;

export interface WordFileSnapshot {
  filePath: string;
  bytes: Uint8Array;
  version: string;
}

export interface WordCheckpoint {
  bytes: Uint8Array;
  baseVersion: string;
  revision: number;
}

export interface WordOpenResult extends WordFileSnapshot {
  sessionId: string;
  recovery?: WordCheckpoint;
}

export type WordResult<T> = { success: true; value: T } | {
  success: false;
  code: WordFileError;
};

export interface WordWriteRequest extends WordCheckpoint {
  sessionId: string;
}

/** File access is scoped to an opaque handle owned by the main renderer. */
export interface WordFileApi {
  open: (filePath: string) => Promise<WordResult<WordOpenResult>>;
  read: (sessionId: string) => Promise<WordResult<WordFileSnapshot>>;
  checkpoint: (request: WordWriteRequest) => Promise<WordResult<null>>;
  save: (request: WordWriteRequest) => Promise<WordResult<{ version: string; originalCopyPath?: string }>>;
  discardDraft: (sessionId: string) => Promise<WordResult<null>>;
  release: (sessionId: string) => Promise<void>;
}

export interface WordFileBridge extends WordFileApi {
  setHasUnsafeEdits: (unsafe: boolean) => void;
  onChanged: (listener: (sessionId: string) => void) => () => void;
}
