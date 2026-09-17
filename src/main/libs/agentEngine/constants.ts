export const AgentLifecyclePhase = {
  Start: 'start',
  End: 'end',
  Error: 'error',
  Fallback: 'fallback',
} as const;
export type AgentLifecyclePhase = typeof AgentLifecyclePhase[keyof typeof AgentLifecyclePhase];

export const AgentEventStream = {
  Assistant: 'assistant',
  Lifecycle: 'lifecycle',
  Tool: 'tool',
} as const;

export const OpenClawChatState = {
  Delta: 'delta',
  Final: 'final',
  Aborted: 'aborted',
  Error: 'error',
} as const;
export type OpenClawChatState = typeof OpenClawChatState[keyof typeof OpenClawChatState];

export const OpenClawGatewayMethod = {
  ChatAbort: 'chat.abort',
  ChatSend: 'chat.send',
  SessionsSubscribe: 'sessions.subscribe',
} as const;
