import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentBubble,
  storedMessageToAgentMessage,
} from "@/components/agent/agent-chat-workspace";
import {
  composeTurnSourceText,
  createAgentTextAttachment,
} from "@/lib/agent/large-text-attachment";

/**
 * Founder report: a long paste became a "Pasted text" chip in the composer,
 * then arrived in the transcript as one enormous user bubble listing every
 * line. The paste is an attachment end to end: a chip in the bubble, a chip on
 * reload, a separate part on the wire, and still whole for memory capture.
 */
const PASTE = Array.from({ length: 30 }, (_, index) => `ledger row ${index}`).join("\n");

type BubbleMessage = Parameters<typeof AgentBubble>[0]["message"];

function userMessage(text: string): BubbleMessage {
  return {
    id: "msg-1-user",
    role: "user",
    text,
    timestamp: "9:41 AM",
    attachments: [createAgentTextAttachment(PASTE)],
  };
}

describe("sent user bubble with a pasted attachment", () => {
  it("shows the typed text and a compact chip, never the pasted body", () => {
    render(<AgentBubble message={userMessage("Summarize this")} />);

    expect(screen.getByText("Summarize this")).toBeTruthy();
    const chip = screen.getByRole("button", { name: /Pasted text/ });
    expect(chip.textContent).toContain("30 lines");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/ledger row 7/)).toBeNull();
  });

  it("previews the pasted body only when the person opens the chip", () => {
    render(<AgentBubble message={userMessage("")} />);

    const chip = screen.getByRole("button", { name: /Pasted text/ });
    fireEvent.click(chip);

    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("agent-message-attachment-preview").textContent).toBe(PASTE);
  });
});

describe("reloaded history", () => {
  it("rehydrates the attachment as a chip beside the typed text", () => {
    const restored = storedMessageToAgentMessage({
      id: "event-1",
      conversation_id: "thread-1",
      role: "user",
      status: "complete",
      content: "Summarize this",
      metadata: { attachments: [createAgentTextAttachment(PASTE)] },
    });

    expect(restored?.text).toBe("Summarize this");
    expect(restored?.attachments).toEqual([createAgentTextAttachment(PASTE)]);

    render(<AgentBubble message={restored!} />);
    expect(screen.getByRole("button", { name: /Pasted text/ })).toBeTruthy();
    expect(screen.queryByText(/ledger row 7/)).toBeNull();
  });
});

describe("memory capture input", () => {
  it("still receives the whole turn: typed text first, then the pasted text", () => {
    const attachment = createAgentTextAttachment(PASTE);

    expect(composeTurnSourceText("Remember these", [attachment])).toBe(`Remember these\n\n${PASTE}`);
    expect(composeTurnSourceText("", [attachment])).toBe(PASTE);
    expect(composeTurnSourceText("Just typed", [])).toBe("Just typed");
  });

  it("is what the workspace hands the capture lane, while the wire gets the parts", () => {
    const source = readFileSync(
      join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    const submit = source.slice(
      source.indexOf("const submitComposerText = async"),
      source.indexOf("const handleSubmit = async"),
    );

    // Send never folds the paste back into the message text.
    expect(submit).not.toContain("combineAttachmentAndComposerText");
    expect(submit).toContain("attachments: submittedAttachments");
    expect(source).toContain("const turnSourceText = composeTurnSourceText(text, attachments)");
    expect(source).toContain("sourceMessage: turnSourceText");
    expect(source).not.toMatch(/sourceMessage: text,/);
    expect(source).toMatch(/streamAgentChat\(\{\s+userId,\s+message: text,\s+attachments,/);
  });

  it("keeps text typed before a large paste as the message, not inside the chip", () => {
    const source = readFileSync(
      join(process.cwd(), "components/agent/agent-chat-workspace.tsx"),
      "utf8",
    );
    const paste = source.slice(
      source.indexOf("const handleComposerPaste = "),
      source.indexOf("const openLongPromptAttachment = "),
    );
    const collapsedBranch = paste.slice(paste.indexOf("return;\n    }"));

    expect(collapsedBranch).toContain("attachmentText: pasted");
    expect(collapsedBranch).not.toContain("setInput(");
    expect(collapsedBranch).not.toContain("currentText: input");
  });
});
