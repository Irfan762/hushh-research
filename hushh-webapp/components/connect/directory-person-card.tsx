"use client";

import type { ReactNode } from "react";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import type { DirectoryPerson } from "@/lib/services/connections-service";
import { getDirectoryPersonDescription } from "@/app/connect/directory-person-label";

/** Presentation only: the directory page retains every request/selection action. */
export function DirectoryPersonCard({
  person,
  leading,
  title,
  onClick,
  trailing,
}: {
  person: DirectoryPerson;
  leading: ReactNode;
  title: ReactNode;
  density?: "compact";
  onClick?: () => void;
  trailing: ReactNode;
}) {
  const name = person.displayName || "Hussh member";
  const detail = getDirectoryPersonDescription(person);
  const mutualCount = person.mutualConnectionCount ?? 0;
  const mutual = person.mutualConnectionPreview;
  const identity = (
    <>
      <span className="relative -mt-8 flex justify-center [&>span]:!size-16 [&>span]:border-4 [&>span]:border-[color:var(--app-card-surface-default-solid)]">
        {leading}
      </span>
      <span className="ui-text-row-label-compact mt-2 block text-center [overflow-wrap:anywhere]">
        {title}
      </span>
      {detail ? (
        <span className="ui-text-caption mt-1 block text-center text-[color:var(--app-secondary-label)] [overflow-wrap:anywhere]">
          {detail}
        </span>
      ) : null}
    </>
  );
  return (
    <article
      data-testid="directory-person-card"
      className="flex min-w-0 flex-col overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)]"
    >
      <div
        aria-hidden="true"
        className="h-16 bg-gradient-to-br from-[color:var(--app-accent-tint)] to-[color:var(--app-secondary-surface)]"
      />
      <div className="flex flex-1 flex-col px-3 pb-3">
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            aria-label={`Open ${name}'s profile`}
            className="min-w-0 rounded-[var(--app-radius-sm)] text-[color:var(--app-label)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          >
            {identity}
          </button>
        ) : (
          <div className="min-w-0">{identity}</div>
        )}
        <div className="mt-auto min-h-11 py-3">
          {mutualCount > 0 ? (
            <div
              className="flex items-center gap-1.5 text-xs text-[color:var(--app-secondary-label)]"
              data-testid="mutual-connection"
            >
              {mutual ? (
                <ConnectionPersonAvatar
                  size="compact"
                  className="!size-4 shrink-0"
                  photoUrl={mutual.photoUrl}
                  label={mutual.displayName}
                />
              ) : null}
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {mutual
                  ? mutualCount === 1
                    ? `${mutual.displayName} is a mutual connection`
                    : `${mutual.displayName} & ${mutualCount - 1} ${mutualCount === 2 ? "other" : "others"} mutual`
                  : `${mutualCount} mutual ${mutualCount === 1 ? "connection" : "connections"}`}
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex min-h-11 items-center justify-center [&>button:not([role=checkbox])]:!m-0 [&>button:not([role=checkbox])]:!w-full [&>button:not([role=checkbox])]:!border [&>button:not([role=checkbox])]:!border-[color:var(--app-accent)] [&>button:not([role=checkbox])]:!bg-transparent [&>button:not([role=checkbox])]:!text-[color:var(--app-accent)]">
          {trailing}
        </div>
      </div>
    </article>
  );
}
