import type { MessageView } from "../shared/work-state";
export interface Session {
  id: string;
  title: string;
  projectPath: string;
  updatedAt: number;
  revision: number;
  adapter: string;
  model: string;
  effort: string;
  providerSession?: Record<string, unknown>;
  messages: MessageView[];
  active?: boolean;
}
let token = "";
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Webui-Token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}
export async function bootstrap() {
  const value = await api<{ token: string; defaultProjectPath: string }>("/bootstrap");
  token = value.token;
  return value;
}
export function invoke(body: unknown, signal: AbortSignal) {
  return fetch("/api/invoke", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "X-Webui-Token": token },
    body: JSON.stringify(body)
  });
}
