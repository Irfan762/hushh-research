"use client";

/**
 * Allow / Don't allow for one owner request, from any surface.
 *
 * The Feed and the owner's own chat card both decide inline. Both go through
 * this hook, which goes through `useConsentActions`, so there is exactly one
 * approve path (the on-device encrypted export, then the server call) and one
 * deny path, whichever button was tapped.
 *
 * The vault is the one thing an inline button cannot assume. Allowing builds
 * the export from the owner's encrypted memory on this device, so it needs the
 * vault key; the old path answered a locked vault with a toast that navigated
 * somewhere else and dropped the decision. Here the decision waits: the unlock
 * prompt opens, and when the key arrives the same decision runs. Cancelling the
 * unlock cancels the decision and nothing is sent.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useVault } from "@/lib/vault/vault-context";
import { useConsentActions } from "@/lib/consent/use-consent-actions";
import {
  consentEntryToPendingConsent,
  type OwnerConsentRequest,
} from "@/lib/consent/owner-consent-request";
import { joinInformationLabels } from "@/lib/consent/consent-owner-copy";

export type OwnerConsentDecisionKind = "allow" | "deny";

type PendingUnlock = {
  kind: OwnerConsentDecisionKind;
  request: OwnerConsentRequest;
  durationHours?: number;
  resolve: (decided: boolean) => void;
  reject: (error: unknown) => void;
};

export type OwnerConsentUnlockPrompt = {
  open: boolean;
  title: string;
  description: string;
  /** Close without unlocking: the waiting decision is dropped, nothing sent. */
  cancel: () => void;
};

export function allowSuccessMessage(request: OwnerConsentRequest): string {
  return `${request.requesterShortName} can now see your ${joinInformationLabels(request.labels)}.`;
}

export function useOwnerConsentDecision(options: {
  userId: string | null | undefined;
}) {
  const { vaultKey } = useVault();
  const actions = useConsentActions({ userId: options.userId });
  const [pendingUnlock, setPendingUnlock] = useState<PendingUnlock | null>(
    null,
  );

  // useConsentActions returns a fresh object every render; reading it through
  // a ref keeps `allow`/`deny` stable, so a list that builds rows around them
  // (the Feed memoises its rows) does not rebuild on every render.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const run = useCallback(
    async (
      kind: OwnerConsentDecisionKind,
      request: OwnerConsentRequest,
      durationHours?: number,
    ): Promise<void> => {
      if (!request.complete) {
        throw new Error("This request is still arriving. Open Details to review it.");
      }
      if (kind === "allow") {
        await actionsRef.current.handleApproveBundle(
          request.members.map((member) =>
            consentEntryToPendingConsent(
              member,
              durationHours ?? request.durationHours ?? undefined,
            ),
          ),
          {
            bundleId: request.key,
            successMessage: allowSuccessMessage(request),
          },
        );
        return;
      }
      await actionsRef.current.handleDenyBundle(
        request.members.map((member) => member.request_id || member.id),
        { bundleId: request.key, successMessage: "Declined. Nothing was shared." },
      );
    },
    [],
  );

  const decide = useCallback(
    (
      kind: OwnerConsentDecisionKind,
      request: OwnerConsentRequest,
      durationHours?: number,
    ): Promise<boolean> => {
      if (vaultKey) {
        return run(kind, request, durationHours).then(() => true);
      }
      return new Promise<boolean>((resolve, reject) => {
        setPendingUnlock((current) => {
          // A second tap while the prompt is open replaces the first; the
          // first resolves as not decided so its spinner stops.
          current?.resolve(false);
          return { kind, request, durationHours, resolve, reject };
        });
      });
    },
    [run, vaultKey],
  );

  useEffect(() => {
    if (!pendingUnlock || !vaultKey) return;
    const waiting = pendingUnlock;
    setPendingUnlock(null);
    // The actions ref is refreshed by the render that carried the new key, so
    // this runs the approve path that can see it.
    run(waiting.kind, waiting.request, waiting.durationHours)
      .then(() => waiting.resolve(true), waiting.reject);
  }, [pendingUnlock, run, vaultKey]);

  const cancel = useCallback(() => {
    setPendingUnlock((current) => {
      current?.resolve(false);
      return null;
    });
  }, []);

  const unlockPrompt: OwnerConsentUnlockPrompt = {
    open: Boolean(pendingUnlock),
    title:
      pendingUnlock?.kind === "deny" ? "Unlock to decline" : "Unlock to allow",
    description: pendingUnlock
      ? pendingUnlock.kind === "deny"
        ? `Unlock your vault to answer ${pendingUnlock.request.requesterShortName}. Nothing is shared.`
        : `Your ${joinInformationLabels(pendingUnlock.request.labels)} stays encrypted on this device until you unlock. Nothing is shared before you do.`
      : "",
    cancel,
  };

  const allow = useCallback(
    (request: OwnerConsentRequest, durationHours?: number) =>
      decide("allow", request, durationHours),
    [decide],
  );
  const deny = useCallback(
    (request: OwnerConsentRequest) => decide("deny", request),
    [decide],
  );

  return {
    allow,
    deny,
    unlockPrompt,
    bundleProgress: actions.bundleProgress,
  };
}
