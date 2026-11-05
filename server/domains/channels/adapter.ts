// Channel adapter contract (SPEC: Channels, contract v1 — #271 slice 1).
// Transport-only surface: the core owns routing, binding, durability and
// acks; an adapter never sees Tandem task ids or Tandem user ids and never
// branches core logic. Adding a channel kind = one new adapter file.

export type ChannelCapabilities = {
  /** outbound edit-in-place support; false → final-only outbound */
  edit: boolean;
  threads: boolean;
  /** hard cap applied to every outbound message (acks included) */
  maxLen: number;
  markdown: boolean;
};

export type ChannelInboundMessage = {
  /** platform thread id (matrix room id) */
  threadRef: string;
  /** platform sender id — resolved against bindings by the core (default deny) */
  senderPlatformId: string;
  text: string;
  /** the raw platform event, persisted for forensics */
  raw: unknown;
  /** stable platform event id — the durability dedupe key */
  externalId: string;
};

export type AdapterStartContext = {
  /** the core sink: persist → enqueue. May throw (redis/db outage) — the
   * adapter must retry the same batch, never drop the message. */
  onMessage: (m: ChannelInboundMessage) => Promise<void>;
  /** durable sync checkpoint (settings-backed). get() null = first boot →
   * the adapter skips history and only delivers events from now on. */
  checkpoint: {
    get(): Promise<string | null>;
    set(v: string): Promise<void>;
  };
};

export type ChannelAdapter = {
  readonly kind: string;
  readonly capabilities: ChannelCapabilities;
  start(ctx: AdapterStartContext): Promise<void>;
  stop(): Promise<void>;
  /** transport-level send, already truncated to capabilities.maxLen */
  send(target: string, text: string): Promise<void>;
};

/** cap outbound text to the adapter's maxLen */
export function capToMaxLen(text: string, caps: ChannelCapabilities): string {
  return text.length > caps.maxLen ? `${text.slice(0, caps.maxLen - 1)}…` : text;
}
