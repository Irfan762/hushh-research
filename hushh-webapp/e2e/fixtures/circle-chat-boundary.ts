// Layout/failure fixture adapter only. The spec renders the production chat,
// shared controls, lifecycle coordinator and image viewer with the app CSS.
import { ApiError } from "../../lib/services/api-client";
const history = Array.from({ length: 45 }, (_, index) => ({
  id: `message-${index}`, sequence: index + 1, senderUserId: index % 2 ? "alice" : "bob",
  senderName: "A member with a long display name", createdAt: "2026-10-02T10:00:00Z",
  text: index === 44 ? "LongText".repeat(100) : `Message ${index + 1} with a friendly reply.`, image: index === 44,
}));
let failed = false;
const fixture = window as unknown as { chatFixture: { failNext: boolean; sends: unknown[]; read: number[]; loseAccess: boolean } };
fixture.chatFixture = { failNext: false, sends: [], read: [], loseAccess: false };
export const CircleChatService = {
  initialize: async () => undefined,
  wait: () => new Promise(() => {}),
  state: async () => ({ unreadCount: 1, latestSequence: history.at(-1)!.sequence, muted: false }),
  messages: async (_session: unknown, cursor: { before?: number; after?: number } = {}) => {
    if (fixture.chatFixture.loseAccess) throw new ApiError("Circle unavailable", 404, { detail: { code: "CIRCLE_CHAT_UNAVAILABLE" } });
    const rows = history.filter((m) => (!cursor.before || m.sequence < cursor.before) && (!cursor.after || m.sequence > cursor.after));
    return { items: cursor.after ? rows.slice(0, 40) : rows.slice(-40), hasMore: rows.length > 40 };
  },
  open: async (_session: unknown, message: typeof history[number]) => ({ text: message.text,
    image: message.image ? { name: "family.png", type: "image/png" } : null }),
  prepare: async (_session: unknown, text: string, file: File | null) => ({ clientMessageId: "retry-id", text, image: Boolean(file) }),
  send: async (_session: unknown, payload: { text: string; image: boolean }) => {
    fixture.chatFixture.sends.push(payload);
    if (fixture.chatFixture.failNext && !failed) { failed = true; throw new ApiError("Delivery timed out", 504); }
    const message = { id: `message-${history.length}`, sequence: history.length + 1, senderUserId: "alice", senderName: "Alice", createdAt: new Date().toISOString(), ...payload };
    history.push(message);
    return message;
  },
  read: async (_session: unknown, sequence: number) => { fixture.chatFixture.read.push(sequence); },
  mute: async (_session: unknown, muted: boolean) => ({ muted }),
  image: async () => new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5KsAAAAASUVORK5CYII="), (c) => c.charCodeAt(0))], { type: "image/png" }),
};
