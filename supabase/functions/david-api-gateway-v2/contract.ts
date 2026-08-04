export const GATEWAY_VERSION = "david-api-gateway-v2-stage4";
export const MAX_BODY_BYTES = 65_536;
export const MAX_REQUEST_KEY_CHARS = 160;
export const MAX_RESPONSE_BYTES = 16_384;

export const OPERATIONS = [
  "health",
  "bootstrap",
  "get_identity",
  "set_consent",
  "list_consents",
  "register_local_conversation",
  "list_conversations",
  "create_thread",
  "list_threads"
] as const;

export type GatewayOperation = typeof OPERATIONS[number];

export const MUTATION_OPERATIONS = new Set<GatewayOperation>([
  "bootstrap",
  "set_consent",
  "register_local_conversation",
  "create_thread"
]);

export const OPERATION_RPC: Record<Exclude<GatewayOperation, "health">, string> = {
  bootstrap: "david_v2_provision_my_identity",
  get_identity: "david_v2_get_my_identity",
  set_consent: "david_v2_set_my_consent",
  list_consents: "david_v2_list_my_consents",
  register_local_conversation: "david_v2_register_my_local_conversation",
  list_conversations: "david_v2_list_my_conversations",
  create_thread: "david_v2_create_my_thread",
  list_threads: "david_v2_list_my_threads"
};
