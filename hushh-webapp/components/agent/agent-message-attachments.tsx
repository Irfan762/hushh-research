"use client";

import { useId, useState } from "react";
import { ChevronDown, FileText } from "lucide-react";

import {
  formatTextAttachmentSize,
  type AgentTextAttachment,
} from "@/lib/agent/large-text-attachment";
import { cn } from "@/lib/utils";

/**
 * Pasted text sent with a user turn, shown as a compact chip inside the user
 * bubble. The body stays collapsed; opening the chip previews it in a bounded,
 * scrollable panel so a long paste never takes over the transcript.
 */
export function AgentMessageAttachments({
  attachments,
}: {
  attachments?: readonly AgentTextAttachment[];
}) {
  if (!attachments?.length) return null;
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="agent-message-attachments">
      {attachments.map((attachment, index) => (
        <AgentMessageAttachmentChip key={`${attachment.name}-${index}`} attachment={attachment} />
      ))}
    </div>
  );
}

function AgentMessageAttachmentChip({ attachment }: { attachment: AgentTextAttachment }) {
  const [open, setOpen] = useState(false);
  const previewId = useId();
  return (
    <div className="w-full min-w-0" data-testid="agent-message-attachment">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={previewId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 rounded-2xl border border-white/25 bg-white/15 px-3 py-2 text-left transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      >
        <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{attachment.name}</span>
          <span className="block text-xs opacity-80">{formatTextAttachmentSize(attachment)}</span>
        </span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <pre
          id={previewId}
          data-testid="agent-message-attachment-preview"
          className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/15 px-3 py-2 font-mono text-xs leading-5"
        >
          {attachment.text}
        </pre>
      ) : null}
    </div>
  );
}
