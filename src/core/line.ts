import type { LineMessage } from "./types";

const API = "https://api.line.me/v2/bot";

/** Verify the X-Line-Signature header (HMAC-SHA256 of the raw body, base64). */
export async function verifySignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const expected = btoa(String.fromCharCode(...mac));
  // constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export interface LineApi {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
  push(to: string, messages: LineMessage[]): Promise<void>;
  groupMemberName(groupId: string, userId: string): Promise<string | undefined>;
}

export class LineClient implements LineApi {
  constructor(private token: string, private fetchFn: typeof fetch = fetch) {}

  private async call(path: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`LINE API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    if (!messages.length) return;
    await this.call("/message/reply", { method: "POST", body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }) });
  }

  async push(to: string, messages: LineMessage[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 5) {
      await this.call("/message/push", { method: "POST", body: JSON.stringify({ to, messages: messages.slice(i, i + 5) }) });
    }
  }

  async groupMemberName(groupId: string, userId: string): Promise<string | undefined> {
    const res = await this.call(`/group/${groupId}/member/${userId}`, { method: "GET" });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { displayName?: string };
    return data.displayName;
  }
}
