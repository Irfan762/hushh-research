"use client";

/**
 * Profile > Preferences: "How One writes to you".
 *
 * The owner's standing style settings, stored encrypted in the reserved
 * `identity.communication_preferences` branch. This is the only place they are
 * edited: chat can only propose a change (its offer card hands the values here
 * in memory), and the owner commits with Save, through the Settings writer.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { CommunicationPreferencesGroup } from "@/components/profile/communication-preferences-group";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { LockedRowIcon } from "@/components/icons/agents";
import {
  OWNER_STYLE_BRANCH,
  OWNER_STYLE_DOMAIN,
  ownerStyleFromBranch,
  takeOwnerStyleProposal,
  type OwnerStyleSettings,
} from "@/lib/agent/owner-style-settings";
import { saveOwnerStyleSettings } from "@/lib/agent/owner-style-settings-writer";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";

function sameSettings(left: OwnerStyleSettings, right: OwnerStyleSettings): boolean {
  return JSON.stringify(ownerStyleFromBranch(left)) === JSON.stringify(ownerStyleFromBranch(right));
}

export function CommunicationPreferencesSection({
  userId,
  vaultKey,
  vaultOwnerToken,
  onRequestUnlock,
}: {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  onRequestUnlock: () => void;
}) {
  const [saved, setSaved] = useState<OwnerStyleSettings | null>(null);
  const [draft, setDraft] = useState<OwnerStyleSettings>({});
  const [suggested, setSuggested] = useState(false);
  const [saving, setSaving] = useState(false);
  const unlocked = Boolean(userId && vaultKey && vaultOwnerToken);

  useEffect(() => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
    let cancelled = false;
    void (async () => {
      let stored: OwnerStyleSettings = {};
      try {
        const snapshot = await PkmDomainResourceService.getStaleFirst({
          userId,
          domain: OWNER_STYLE_DOMAIN,
          vaultKey,
          vaultOwnerToken,
          backgroundRefresh: false,
        });
        stored = ownerStyleFromBranch(snapshot?.data?.[OWNER_STYLE_BRANCH]);
      } catch {
        stored = {};
      }
      if (cancelled) return;
      // A chat offer is applied over what is stored, and only shown here.
      const proposal = takeOwnerStyleProposal(userId);
      setSaved(stored);
      setDraft(proposal ? { ...stored, ...proposal } : stored);
      setSuggested(Boolean(proposal));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, vaultKey, vaultOwnerToken]);

  const dirty = useMemo(() => saved !== null && !sameSettings(saved, draft), [saved, draft]);

  if (!unlocked) {
    return (
      <SettingsGroup title="How One writes to you" testId="style-settings-group">
        <SettingsRow
          icon={LockedRowIcon}
          iconTone="capability"
          title="Unlock to edit"
          description="Your writing style is stored in your vault."
          onClick={onRequestUnlock}
          chevron
        />
      </SettingsGroup>
    );
  }

  return (
    <CommunicationPreferencesGroup
      value={draft}
      onChange={(next) => {
        setDraft(next);
        setSuggested(false);
      }}
      dirty={dirty}
      saving={saving}
      suggested={suggested && dirty}
      onSave={async () => {
        if (!userId) return;
        setSaving(true);
        try {
          const ok = await saveOwnerStyleSettings({ userId, vaultKey, vaultOwnerToken, settings: draft });
          if (!ok) throw new Error("save failed");
          const clean = ownerStyleFromBranch(draft);
          setSaved(clean);
          setDraft(clean);
          setSuggested(false);
          toast.success("Writing style saved");
        } catch {
          toast.error("Couldn't save your writing style. Please try again.");
        } finally {
          setSaving(false);
        }
      }}
    />
  );
}
