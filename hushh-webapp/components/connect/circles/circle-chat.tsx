"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { MessageCircle, ImageIcon, Send, X, Loader2 } from "@/components/icons";
import { CircleChatService, type CircleChatSession, type CircleChatState } from "@/lib/services/circle-chat-service";
import { ApiError, apiErrorCode } from "@/lib/services/api-client";
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_TEXT, type ChatContent, type ChatMessage, type SealedChatMessage } from "@/lib/circle-chat/crypto";
import { CIRCLE_CHAT_CHANGED, dispatchCircleChatChanged } from "@/lib/circle-chat/events";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { circleStateChangeClosesDetail, subscribeToOneLocationStateChanges } from "@/lib/one-location/one-location-state-events";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

type OpenMessage = ChatMessage & { content: ChatContent | null; failed: boolean };
const unavailable = (error: unknown) => error instanceof ApiError &&
  ([401, 403, 423].includes(error.status) || apiErrorCode(error) === "CIRCLE_CHAT_UNAVAILABLE");
const errorText = (error: unknown) => error instanceof Error ? error.message : "Chat could not connect. Try again.";
const foreground = () => document.visibilityState === "visible" && appInteractionCoordinator.getLifecycleSnapshot().state === "active";

export function CircleChat({ session, circleName, initialOpen = false, onOpenIntentConsumed }: {
  session: CircleChatSession; circleName: string; initialOpen?: boolean; onOpenIntentConsumed?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [started, setStarted] = useState(initialOpen);
  useEffect(() => { if (initialOpen) { setOpen(true); setStarted(true); onOpenIntentConsumed?.(); } }, [initialOpen, onOpenIntentConsumed]);
  const [state, setState] = useState<CircleChatState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [revision, setRevision] = useState(0);
  const [muting, setMuting] = useState(false);
  useEffect(() => {
    let active = true;
    let cursor = 0;
    let running = false;
    let abort: AbortController | null = null;
    const listen = async () => {
      if (!active || running || !foreground() || revoked) return;
      running = true;
      abort = new AbortController();
      try {
        while (active && foreground()) {
          const next = await CircleChatService.wait(session, cursor, abort.signal);
          if (!active || abort.signal.aborted || !foreground()) break;
          cursor = next.latestSequence;
          dispatchCircleChatChanged(session.userId, session.circleId);
          dispatchFeedStateChanged("arrived");
        }
      } catch (err) {
        if (active && !abort.signal.aborted && unavailable(err)) { setRevoked(true); setState(null); setOpen(false); }
      } finally { running = false; }
    };
    const resume = () => { if (!foreground()) abort?.abort(); else void listen(); };
    void listen();
    const timer = window.setInterval(resume, 5000);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(resume);
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume);
    return () => { active = false; abort?.abort(); clearInterval(timer); removeLifecycle();
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); };
  }, [session, revoked]);
  useEffect(() => {
    let active = true;
    let running = false;
    let ready = false;
    const abort = new AbortController();
    setState(null); setError(null); setRevoked(false);
    const refresh = async () => {
      if (!active || running || !foreground()) return;
      running = true;
      try {
        if (!ready) { await CircleChatService.initialize(session); ready = true; }
        if (!active) return;
        const next = await CircleChatService.state(session, abort.signal);
        if (active) { setState(next); setError(null); }
      } catch (err) {
        if (active && !abort.signal.aborted) {
          setError(errorText(err));
          if (unavailable(err)) { setRevoked(true); setState(null); setOpen(false); active = false; abort.abort(); }
        }
      } finally { running = false; }
    };
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; circleId: string }>).detail;
      if (detail?.userId === session.userId && detail.circleId === session.circleId) void refresh();
    };
    const unsubscribe = subscribeToOneLocationStateChanges((detail) => {
      if (detail.userId === session.userId && circleStateChangeClosesDetail(detail, session.userId, session.circleId)) {
        active = false; abort.abort(); setRevoked(true); setState(null); setOpen(false);
      }
    });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    window.addEventListener(CIRCLE_CHAT_CHANGED, onEvent);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void refresh(); });
    return () => { active = false; abort.abort(); clearInterval(timer); unsubscribe(); removeLifecycle();
      window.removeEventListener(CIRCLE_CHAT_CHANGED, onEvent); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [session, revision]);

  return <section aria-label={`${circleName} chat`} className="rounded-[var(--app-card-radius-standard)] border border-border bg-card p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button variant={open ? "secondary" : "outline"} onClick={() => { setOpen(!open); setStarted(true); }} disabled={revoked || !state} aria-expanded={open}>
        <MessageCircle aria-hidden="true" className="size-4" /> Circle chat
        {state && state.unreadCount > 0 ? <span aria-label={`${state.unreadCount} unread messages`} className="rounded-full bg-primary px-2 text-primary-foreground">{state.unreadCount}</span> : null}
      </Button>
      {open && state ? <Button variant="ghost" size="sm" className="min-h-11" disabled={muting} onClick={async () => {
        setMuting(true);
        try { const next = await CircleChatService.mute(session, !state.muted); setState((old) => old ? { ...old, muted: next.muted } : old); }
        catch (err) { setError(errorText(err)); } finally { setMuting(false); }
      }}>{state.muted ? "Unmute notifications" : "Mute notifications"}</Button> : null}
    </div>
    {!state && !error && !revoked ? <p role="status" className="mt-3 text-sm text-muted-foreground">Connecting chat…</p> : null}
    {revoked ? <p role="alert" className="mt-3 text-sm">You no longer have access to this circle chat.</p> : null}
    {error && !revoked ? <div role="alert" className="mt-3 text-sm">{error} <Button variant="ghost" size="sm" onClick={() => setRevision((n) => n + 1)}>Reconnect</Button></div> : null}
    {started && state && !revoked ? <div hidden={!open}><CircleChatThread session={session} visible={open}
      onRead={(sequence) => setState((old) => old && old.latestSequence <= sequence ? { ...old, unreadCount: 0 } : old)}
      onRevoked={() => { setRevoked(true); setState(null); setOpen(false); }} /></div> : null}
  </section>;
}

function CircleChatThread({ session, visible, onRead, onRevoked }: {
  session: CircleChatSession; visible: boolean; onRead: (sequence: number) => void; onRevoked: () => void;
}) {
  const [messages, setMessages] = useState<OpenMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<SealedChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readRevision, setReadRevision] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const transcript = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  const last = useRef(0);
  const readThrough = useRef(0);
  const reading = useRef(false);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const running = useRef(false);
  const sendLock = useRef(false);
  const atBottomRef = useRef(true);
  const bottomInViewport = useRef(false);
  const onReadRef = useRef(onRead); onReadRef.current = onRead;
  const onRevokedRef = useRef(onRevoked); onRevokedRef.current = onRevoked;
  const fileInput = useRef<HTMLInputElement>(null);

  const fail = useCallback((err: unknown) => {
    if (!active.current) return;
    if (unavailable(err)) { active.current = false; setMessages([]); setText(""); setFile(null); setPending(null); onRevokedRef.current(); }
    else setError(errorText(err));
  }, []);
  const decrypt = useCallback(async (items: ChatMessage[]) => Promise.all(items.map(async (message) => {
    try { return { ...message, content: await CircleChatService.open(session, message), failed: false }; }
    catch { return { ...message, content: null, failed: true }; }
  })), [session]);
  const append = useCallback((items: OpenMessage[]) => {
    if (!active.current || !items.length) return;
    const merged = [...new Map([...messagesRef.current, ...items].map((item) => [item.id, item])).values()].sort((a, b) => a.sequence - b.sequence);
    if (merged.length > 300) setHasOlder(true);
    messagesRef.current = merged.slice(-300);
    setMessages(messagesRef.current);
    if (atBottomRef.current) requestAnimationFrame(() => {
      if (active.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
  }, []);

  useEffect(() => {
    active.current = true;
    const abort = new AbortController();
    const refresh = async () => {
      if (!active.current || !visibleRef.current || running.current || !foreground()
          || !atBottomRef.current && messagesRef.current.length >= 300) return;
      running.current = true;
      try {
        const incremental = last.current > 0;
        let page = await CircleChatService.messages(session, incremental ? { after: last.current } : {}, abort.signal);
        if (!active.current) return;
        if (!last.current) setHasOlder(page.hasMore);
        append(await decrypt(page.items));
        if (active.current && page.items.length) last.current = Math.max(last.current, ...page.items.map((item) => item.sequence));
        // Repair a reconnect gap in bounded pages, without skipping any sequence.
        for (let i = 0; incremental && page.hasMore && last.current && i < 4 && active.current; i++) {
          page = await CircleChatService.messages(session, { after: last.current }, abort.signal);
          append(await decrypt(page.items));
          if (active.current && page.items.length) last.current = Math.max(last.current, ...page.items.map((item) => item.sequence));
        }
        if (active.current) { setLoading(false); if (!sendLock.current) setError(null); setReadRevision((n) => n + 1); }
      } catch (err) { if (!abort.signal.aborted) fail(err); }
      finally { running.current = false; if (active.current) setLoading(false); }
    };
    const event = (value: Event) => {
      const detail = (value as CustomEvent<{ userId: string; circleId: string }>).detail;
      if (detail?.userId === session.userId && detail.circleId === session.circleId) void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener(CIRCLE_CHAT_CHANGED, event); window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void refresh(); });
    return () => { active.current = false; abort.abort(); clearInterval(timer); removeLifecycle();
      window.removeEventListener(CIRCLE_CHAT_CHANGED, event); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [session, append, decrypt, fail]);

  useEffect(() => {
    if (visible) window.dispatchEvent(new CustomEvent(CIRCLE_CHAT_CHANGED,
      { detail: { userId: session.userId, circleId: session.circleId } }));
  }, [visible, session]);

  useEffect(() => {
    if (!bottom.current || !transcript.current) return;
    const resize = new ResizeObserver(() => {
      if (atBottomRef.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    });
    resize.observe(transcript.current);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      atBottomRef.current = entry.isIntersecting;
      setAtBottom(entry.isIntersecting);
      if (entry.isIntersecting) setReadRevision((n) => n + 1);
    }, { root: transcript.current, threshold: 1 });
    observer.observe(bottom.current);
    const viewportObserver = new IntersectionObserver(([entry]) => {
      bottomInViewport.current = Boolean(entry?.isIntersecting);
      if (entry?.isIntersecting) setReadRevision((n) => n + 1);
    }, { threshold: 1 });
    viewportObserver.observe(bottom.current);
    return () => { resize.disconnect(); observer.disconnect(); viewportObserver.disconnect(); };
  }, []);
  useEffect(() => {
    const read = async () => {
      const sequence = last.current;
      const element = transcript.current;
      if (reading.current || !visibleRef.current || !active.current || !element || element.scrollHeight - element.scrollTop - element.clientHeight > 8
          || !atBottomRef.current || !bottomInViewport.current || !document.hasFocus() || !foreground() || sequence <= readThrough.current) return;
      reading.current = true;
      try { await CircleChatService.read(session, sequence); if (active.current) { readThrough.current = Math.max(readThrough.current, sequence); onReadRef.current(sequence); } }
      catch (err) { fail(err); }
      finally { reading.current = false; }
    };
    void read();
    window.addEventListener("focus", read); document.addEventListener("visibilitychange", read);
    const removeLifecycle = appInteractionCoordinator.subscribeLifecycle(() => { void read(); });
    return () => { removeLifecycle(); window.removeEventListener("focus", read); document.removeEventListener("visibilitychange", read); };
  }, [session, readRevision, messages, fail, visible]);

  const send = async () => {
    if (sendLock.current || !active.current) return;
    sendLock.current = true; setSending(true); setError(null);
    try {
      const sealed = pending ?? await CircleChatService.prepare(session, text, file);
      if (!active.current) return;
      setPending(sealed);
      const sent = await CircleChatService.send(session, sealed);
      if (!active.current) return;
      append(await decrypt([sent]));
      setPending(null); setText(""); setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      fail(err);
      // A definite roster refusal never committed; reseal only on the person's next Send.
      if (["CIRCLE_CHAT_ROSTER_CHANGED", "CIRCLE_CHAT_RETRY_CONFLICT"].includes(apiErrorCode(err) ?? "")) setPending(null);
    } finally { sendLock.current = false; if (active.current) setSending(false); }
  };
  return <div className="mt-4 space-y-3">
    <p className="text-xs text-muted-foreground">Messages are private to members who were in this circle when sent.</p>
    <div ref={transcript} tabIndex={0} aria-label="Circle messages" className="h-[min(32rem,max(10rem,calc(55dvh-var(--kb-height,0px))))] overflow-y-auto overscroll-contain rounded-xl bg-muted/40 p-3">
      {hasOlder ? <Button variant="ghost" size="sm" className="min-h-11" disabled={loadingOlder} onClick={async () => {
        if (!messages.length || loadingOlder || running.current) return;
        running.current = true;
        setLoadingOlder(true);
        const height = transcript.current?.scrollHeight ?? 0;
        try {
          const page = await CircleChatService.messages(session, { before: messages[0]!.sequence });
          const older = await decrypt(page.items);
          if (!active.current) return;
          const window = [...new Map([...older, ...messagesRef.current].map((item) => [item.id, item])).values()].sort((a, b) => a.sequence - b.sequence).slice(0, 300);
          messagesRef.current = window;
          setHasOlder(page.hasMore); setMessages(window);
          last.current = window.at(-1)?.sequence ?? 0;
          requestAnimationFrame(() => { if (active.current && transcript.current) transcript.current.scrollTop += transcript.current.scrollHeight - height; });
        } catch (err) { fail(err); } finally { running.current = false; if (active.current) setLoadingOlder(false); }
      }}>Load earlier messages</Button> : null}
      {loading ? <p role="status" className="text-sm text-muted-foreground">Loading messages…</p> : !messages.length ? <p className="py-8 text-center text-sm text-muted-foreground">Start the conversation. Say hello or share an image.</p> : null}
      <ol className="space-y-3">{messages.map((message) => <li key={message.id} className={`flex ${message.senderUserId === session.userId ? "justify-end" : "justify-start"}`}>
        <div className={`max-w-[90%] min-w-0 rounded-2xl px-3 py-2 sm:max-w-[75%] ${message.senderUserId === session.userId ? "bg-primary/10" : "bg-card"}`}>
          <p className="text-xs font-semibold">{message.senderUserId === session.userId ? "You" : message.senderName}</p>
          {message.failed ? <p className="text-sm text-muted-foreground">This message could not be opened on this device.</p> : <>
            {message.content?.text ? <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{message.content.text}</p> : null}
            {message.content?.image ? <ChatImage session={session} message={message} type={message.content.image.type} onError={fail} /> : null}
          </>}
          <p className="mt-1 text-right text-[11px] text-muted-foreground"><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>{message.senderUserId === session.userId ? " · Sent" : ""}</p>
        </div>
      </li>)}</ol>
      <div ref={bottom} className="h-1" />
    </div>
    {!atBottom && messages.length ? <Button variant="outline" size="sm" className="min-h-11" onClick={() => {
      atBottomRef.current = true;
      if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
      window.dispatchEvent(new CustomEvent(CIRCLE_CHAT_CHANGED, { detail: { userId: session.userId, circleId: session.circleId } }));
    }}>Go to latest messages</Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {file ? <div className="flex min-w-0 items-center gap-2 text-sm"><span className="min-w-0 truncate">{file.name}</span><Button variant="ghost" size="icon-touch" aria-label="Remove attached image" disabled={sending || Boolean(pending)} onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }}><X className="size-4" /></Button></div> : null}
    <form className="flex min-w-0 items-end gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Attach image" disabled={sending || Boolean(pending)} onChange={(event) => {
        const next = event.target.files?.[0];
        if (!next) return;
        if (!next.size || next.size > MAX_CHAT_IMAGE_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(next.type)) { setError("Choose a JPEG, PNG, or WebP image up to 5 MB."); event.target.value = ""; return; }
        setFile(next); setError(null);
      }} />
      <Button type="button" variant="outline" size="icon-touch" aria-label="Choose image" disabled={sending || Boolean(pending)} onClick={() => fileInput.current?.click()}><ImageIcon className="size-5" /></Button>
      <Textarea aria-label="Message" placeholder="Write a message…" value={text} maxLength={MAX_CHAT_TEXT} className="min-h-11 max-h-32 min-w-0 flex-1 resize-none overflow-y-auto text-base sm:text-sm" rows={2} disabled={sending || Boolean(pending)} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) { event.preventDefault(); void send(); }
      }} />
      <Button type="submit" size="icon-touch" aria-label={pending ? "Retry message" : "Send message"} disabled={sending || loading || (!text.trim() && !file && !pending)}>{sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
    </form>
    {pending && !sending ? <p className="text-xs text-muted-foreground">Delivery is unconfirmed. Retry sends the same message safely.</p> : null}
  </div>;
}

function ChatImage({ session, message, type, onError }: { session: CircleChatSession; message: ChatMessage; type: string; onError: (error: unknown) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const epoch = useRef(0);
  const allocated = useRef<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { epoch.current++; abort.current?.abort(); if (allocated.current) URL.revokeObjectURL(allocated.current); }, []);
  // Decrypted blob URLs must stay local; an image optimizer would send them to a server.
  /* eslint-disable @next/next/no-img-element */
  if (url) return <>
    <button type="button" aria-label="Open shared image" className="mt-2 block max-w-full rounded-lg focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setExpanded(true)}><img src={url} alt="Image shared in circle" className="max-h-64 max-w-full rounded-lg object-contain" onError={() => { if (allocated.current) URL.revokeObjectURL(allocated.current); allocated.current = null; setUrl(null); setError(true); }} /></button>
    <Dialog modal open={expanded} onOpenChange={setExpanded}><DialogContent className="sm:max-w-3xl" srDescription="Image shared in this circle"><DialogTitle className="text-base">Shared image</DialogTitle><img src={url} alt="Image shared in circle" className="max-h-[70dvh] max-w-full object-contain" /></DialogContent></Dialog>
  </>;
  return <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11" disabled={loading} onClick={async () => {
    const current = ++epoch.current;
    abort.current = new AbortController(); setLoading(true); setError(false);
    try {
      const blob = await CircleChatService.image(session, message, type, abort.current.signal);
      if (epoch.current !== current) return;
      allocated.current = URL.createObjectURL(blob); setUrl(allocated.current);
    } catch (err) { if (epoch.current === current) { setError(true); onError(err); } }
    finally { if (epoch.current === current) setLoading(false); }
  }}>{loading ? "Opening image…" : error ? "Retry image" : "View image"}</Button>;
}
