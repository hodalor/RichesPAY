import { createClient, type SupabaseClientOptions } from "@supabase/supabase-js";

import type { AppEnv } from "../env";

class NodeRestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = NodeRestWebSocket.CLOSED;
  url = "";
  protocol = "";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  close() {
    this.readyState = NodeRestWebSocket.CLOSED;
  }

  send() {
    return undefined;
  }

  addEventListener() {
    return undefined;
  }

  removeEventListener() {
    return undefined;
  }
}

type RealtimeTransport = NonNullable<
  NonNullable<SupabaseClientOptions<"public">["realtime"]>["transport"]
>;

const serverClientOptions: SupabaseClientOptions<"public"> = {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    // The API only calls Auth over HTTP. Node 20 has no global WebSocket,
    // and the Supabase client refuses to construct without one.
    transport: NodeRestWebSocket as unknown as RealtimeTransport
  }
};

export function createSupabaseAnonClient(env: AppEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, serverClientOptions);
}

export function createSupabaseServiceClient(env: AppEnv) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, serverClientOptions);
}
