import { apiJson } from "@/lib/services/api-client";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { RecipientPayloadKeyUnavailableError } from "@/lib/one-location/encryption";
import type { OneLocationMyRecipientKey } from "@/lib/one-location/types";
import { openChatContent, openChatImage, sealChatMessage, type ChatMemberKey, type ChatMessage, type SealedChatMessage } from "@/lib/circle-chat/crypto";

export type CircleChatState = { members: ChatMemberKey[]; rosterVersion: string; unreadCount: number; latestSequence: number; muted: boolean };
export type CircleChatPage = { items: ChatMessage[]; hasMore: boolean };
export type CircleChatSession = { circleId: string; userId: string; vaultOwnerToken: string; vaultKey: string };
const root = (session: CircleChatSession) => `/api/one/circles/${encodeURIComponent(session.circleId)}/chat`;
function options(session: CircleChatSession, signal?: AbortSignal): RequestInit {
  return { headers: { Authorization: `Bearer ${session.vaultOwnerToken}`, "Content-Type": "application/json" }, signal, cache: "no-store" };
}
// Encrypted historical backups only; a WeakMap does not extend a vault session.
const backups = new WeakMap<CircleChatSession, Map<string, Promise<OneLocationMyRecipientKey>>>();
async function recover<T>(session: CircleChatSession, message: ChatMessage, open: (recovery?: { vaultKey: string; remoteBackup: OneLocationMyRecipientKey }) => Promise<T>): Promise<T> {
  try { return await open(); }
  catch (err) {
    if (!(err instanceof RecipientPayloadKeyUnavailableError)) throw err;
    let keys = backups.get(session);
    if (!keys) { keys = new Map(); backups.set(session, keys); }
    const id = message.envelope.recipientKeyId;
    let backup = keys.get(id);
    if (!backup) {
      if (keys.size >= 8) keys.delete(keys.keys().next().value!);
      backup = apiJson<OneLocationMyRecipientKey>(`${root(session)}/keys/${encodeURIComponent(id)}`, options(session));
      keys.set(id, backup);
    }
    try { return await open({ vaultKey: session.vaultKey, remoteBackup: await backup }); }
    catch (error) { keys.delete(id); throw error; }
  }
}

/** Uses the existing Next proxy and Capacitor JSON transport; no plaintext requests. */
export const CircleChatService = {
  async initialize(session: CircleChatSession): Promise<void> {
    await bootstrapCurrentUserLocationRecipientKey({ userId: session.userId,
      vaultOwnerToken: session.vaultOwnerToken, vaultKey: session.vaultKey, strictRecovery: true });
  },
  state: (session: CircleChatSession, signal?: AbortSignal) => apiJson<CircleChatState>(root(session), options(session, signal)),
  wait: (session: CircleChatSession, after: number, signal?: AbortSignal) => apiJson<{ latestSequence: number }>(
    `${root(session)}/wait?after=${after}`, options(session, signal)),
  messages: (session: CircleChatSession, page: { before?: number; after?: number } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (page.before !== undefined) query.set("before", String(page.before));
    if (page.after !== undefined) query.set("after", String(page.after));
    return apiJson<CircleChatPage>(`${root(session)}/messages?${query}`, options(session, signal));
  },
  async prepare(session: CircleChatSession, text: string, file: File | null): Promise<SealedChatMessage> {
    const state = await CircleChatService.state(session);
    return sealChatMessage({ ...session, text, file, members: state.members, rosterVersion: state.rosterVersion });
  },
  send: (session: CircleChatSession, payload: SealedChatMessage) => apiJson<ChatMessage>(`${root(session)}/messages`,
    { ...options(session), method: "POST", body: JSON.stringify(payload) }),
  open: (session: CircleChatSession, message: ChatMessage) => recover(session, message,
    (recovery) => openChatContent(session.circleId, session.userId, message, recovery)),
  async image(session: CircleChatSession, message: ChatMessage, type: string, signal?: AbortSignal): Promise<Blob> {
    const image = await apiJson<{ ciphertext: string; iv: string }>(`${root(session)}/messages/${encodeURIComponent(message.id)}/image`, options(session, signal));
    return recover(session, message, (recovery) => openChatImage(session.circleId, session.userId, message, image, type, recovery));
  },
  async read(session: CircleChatSession, sequence: number): Promise<void> {
    await apiJson(`${root(session)}/read`, { ...options(session), method: "POST", body: JSON.stringify({ sequence }) });
    dispatchFeedStateChanged("read");
  },
  mute: (session: CircleChatSession, muted: boolean) => apiJson<{ muted: boolean }>(`${root(session)}/preferences`,
    { ...options(session), method: "PUT", body: JSON.stringify({ muted }) }),
};
