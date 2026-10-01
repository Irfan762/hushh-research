"use client";

/** Keeps a reviewed mail draft alive across voice dock and route changes. */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "@/components/icons";

import { EmailDraftCard } from "@/components/agent/email-draft-card";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { parseOpenMailDraftStepPayload } from "@/lib/one-voice/mail-draft-step";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import type { EmailDraft, EmailDeliveryError } from "@/lib/services/email-delivery-service";
import { useVault } from "@/lib/vault/vault-context";

type OpenMailDraft = { id: string; draft: EmailDraft; recipientName: string };
type MailDelivery = {
  id: string;
  draft: EmailDraft;
  recipientName: string;
  status: "sending" | "sent" | "failed" | "outcome_unknown";
  error: string | null;
};
type StepReport = (status: "ok" | "failed", payload?: Record<string, unknown>) => void;
type Viewport = { top: number; left: number; width: number; height: number };

function visibleViewport(): Viewport {
  const viewport = window.visualViewport;
  return viewport
    ? { top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height }
    : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
}

function newAttemptId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function OneVoiceMailDraftBridge() {
  const { user } = useAuth();
  const { isVaultUnlocked, tokenExpiresAt, getVaultOwnerToken } = useVault();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [mailDraft, setMailDraft] = useState<OpenMailDraft | null>(null);
  const [mailDelivery, setMailDelivery] = useState<MailDelivery | null>(null);
  const [vaultDialogOpen, setVaultDialogOpen] = useState(false);
  const draftRef = useRef<OpenMailDraft | null>(null);
  const reportsRef = useRef(new Map<string, StepReport>());
  const handledStepsRef = useRef(new Set<string>());
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const ownerRef = useRef(user?.uid ?? null);

  useEffect(() => {
    setHost(document.body);
    const updateViewport = () => setViewport(visibleViewport());
    updateViewport();
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  useVoiceToolEffects({
    onClientStep: (step, report) => {
      if (step.kind !== "open_mail_draft" || handledStepsRef.current.has(step.stepId)) return;
      handledStepsRef.current.add(step.stepId);
      const parsed = parseOpenMailDraftStepPayload(step.payload);
      if (!parsed) {
        report("failed", { reason: "invalid_mail_draft" });
        return;
      }
      if (draftRef.current) {
        report("failed", { reason: "draft_already_open" });
        return;
      }
      const next: OpenMailDraft = {
        id: step.stepId,
        recipientName: parsed.toName,
        draft: { to: parsed.to, cc: "", bcc: "", subject: parsed.subject, body: parsed.body },
      };
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      draftRef.current = next;
      reportsRef.current.set(step.stepId, report);
      setMailDelivery(null);
      setMailDraft(next);
    },
  });

  // A step succeeds only after the body portal and review card commit.
  useEffect(() => {
    if (!mailDraft || !host) return;
    const report = reportsRef.current.get(mailDraft.id);
    if (!report) return;
    reportsRef.current.delete(mailDraft.id);
    const mounted = Boolean(surfaceRef.current?.querySelector('[data-testid="one-email-draft-card"]'));
    if (mounted) surfaceRef.current?.focus({ preventScroll: true });
    report(mounted ? "ok" : "failed", mounted ? { mounted: true } : { reason: "draft_not_mounted" });
    if (!mounted) {
      draftRef.current = null;
      setMailDraft(null);
    }
  }, [host, mailDraft]);

  useEffect(() => {
    const reports = reportsRef.current;
    return () => {
      for (const report of reports.values()) report("failed", { reason: "surface_unmounted" });
      reports.clear();
    };
  }, []);

  useEffect(() => {
    if (ownerRef.current === (user?.uid ?? null)) return;
    ownerRef.current = user?.uid ?? null;
    for (const report of reportsRef.current.values()) report("failed", { reason: "owner_changed" });
    reportsRef.current.clear();
    handledStepsRef.current.clear();
    draftRef.current = null;
    setMailDraft(null);
    setMailDelivery(null);
    setVaultDialogOpen(false);
  }, [user?.uid]);

  const getMailAuth = useCallback(async () => {
    if (!user || !isVaultUnlocked || (tokenExpiresAt && Date.now() >= tokenExpiresAt)) return null;
    const vaultOwnerToken = getVaultOwnerToken();
    if (!vaultOwnerToken) return null;
    const firebaseIdToken = await user.getIdToken();
    return firebaseIdToken ? { firebaseIdToken, vaultOwnerToken } : null;
  }, [getVaultOwnerToken, isVaultUnlocked, tokenExpiresAt, user]);

  const dismissDraft = () => {
    draftRef.current = null;
    setMailDraft(null);
    const previousFocus = previousFocusRef.current;
    if (previousFocus?.isConnected) window.requestAnimationFrame(() => previousFocus.focus());
  };

  const onMailSendStarted = (reviewedDraft: EmailDraft): string => {
    const id = newAttemptId();
    setMailDelivery({
      id,
      draft: reviewedDraft,
      recipientName: draftRef.current?.recipientName ?? "",
      status: "sending",
      error: null,
    });
    draftRef.current = null;
    setMailDraft(null);
    return id;
  };

  const onMailSent = (id?: string | null) => {
    setMailDelivery((current) => current && current.id === id ? { ...current, status: "sent", error: null } : current);
  };

  const onMailSendFailed = (error: EmailDeliveryError, id?: string | null) => {
    setMailDelivery((current) => current && current.id === id
      ? {
          ...current,
          status: error.code === "EMAIL_ACTION_OUTCOME_UNKNOWN" ? "outcome_unknown" : "failed",
          error: error.message,
        }
      : current);
  };

  const reopenFailedDraft = () => {
    if (!mailDelivery || mailDelivery.status !== "failed") return;
    const next = {
      id: newAttemptId(),
      draft: mailDelivery.draft,
      recipientName: mailDelivery.recipientName,
    };
    draftRef.current = next;
    setMailDraft(next);
    setMailDelivery(null);
  };

  const visible = mailDraft || mailDelivery;
  return (
    <>
      {host && visible ? createPortal(
        <div
          data-testid="one-voice-mail-portal"
          className="pointer-events-none fixed z-[700] flex items-end justify-center px-3 py-3 sm:px-6"
          style={viewport ? {
            top: viewport.top,
            left: viewport.left,
            width: viewport.width,
            height: viewport.height,
          } : { inset: 0 }}
        >
          {mailDraft ? (
            <div
              ref={surfaceRef}
              data-testid="one-voice-mail-draft-surface"
              role="region"
              aria-label={`Mail draft for ${mailDraft.recipientName}`}
              tabIndex={-1}
              className="pointer-events-auto max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-2 shadow-2xl outline-none"
            >
              <EmailDraftCard
                key={mailDraft.id}
                initialInstruction=""
                initialDraft={mailDraft.draft}
                verbatimInitialBody
                getAuth={getMailAuth}
                onRequireVault={() => setVaultDialogOpen(true)}
                onDismiss={dismissDraft}
                onSendStarted={onMailSendStarted}
                onSent={onMailSent}
                onSendFailed={onMailSendFailed}
              />
            </div>
          ) : null}
          {mailDelivery ? (
            <div
              data-testid="one-voice-mail-delivery"
              role="status"
              aria-live="polite"
              className="pointer-events-auto flex h-fit w-full max-w-2xl items-center gap-3 rounded-2xl bg-card px-4 py-3 text-sm shadow-2xl"
            >
              <span className="min-w-0 flex-1">
                {mailDelivery.status === "sending" ? "Sending mail…" :
                  mailDelivery.status === "sent" ? "Mail sent." :
                    mailDelivery.status === "outcome_unknown" ? "Delivery could not be confirmed. Check Sent Mail before trying again." :
                      mailDelivery.error || "Mail could not be sent."}
              </span>
              {mailDelivery.status === "failed" ? (
                <button type="button" className="shrink-0 font-semibold text-[color:var(--app-accent)]" onClick={reopenFailedDraft}>
                  Review draft
                </button>
              ) : null}
              <button type="button" aria-label="Dismiss mail status" onClick={() => setMailDelivery(null)}>
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}
        </div>,
        host,
      ) : null}
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultDialogOpen}
          onOpenChange={setVaultDialogOpen}
          onSuccess={() => setVaultDialogOpen(false)}
          title="Unlock vault to send mail"
          description="Unlock your vault, then review the draft and tap Send again."
          allowVaultCreation={false}
        />
      ) : null}
    </>
  );
}
