export const PROVIDER_ROUTER_VERSION = "david-provider-router-v2-stage5";
export const MAX_BODY_BYTES = 65_536;
export const MAX_PROMPT_CHARS = 32_768;
export const MAX_REQUEST_KEY_CHARS = 160;

export const PROVIDER_OPERATIONS = [
  "health",
  "ensure_conversation",
  "create_run",
  "get_run",
  "list_run_events"
] as const;

export type ProviderOperation = typeof PROVIDER_OPERATIONS[number];

export const PROVIDER_RPC: Record<Exclude<ProviderOperation, "health">, string> = {
  ensure_conversation: "david_v2_ensure_my_provider_conversation",
  create_run: "david_v2_create_my_provider_run",
  get_run: "david_v2_get_my_provider_run",
  list_run_events: "david_v2_list_my_provider_run_events"
};

export const MUTATION_OPERATIONS = new Set<ProviderOperation>([
  "ensure_conversation",
  "create_run"
]);
