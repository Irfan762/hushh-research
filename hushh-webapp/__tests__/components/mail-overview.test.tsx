import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MailOverview } from "@/components/gmail/mail-overview";

describe("Mail overview", () => {
  it("removes the fetching indicator when receipts finish and keeps navigation actionable", () => {
    const onOpenReceipts = vi.fn();
    const onOpenChat = vi.fn();
    const props = { receiptUpdated: "Last updated just now.", onOpenReceipts, onOpenChat };
    const { rerender } = render(<MailOverview {...props} fetching receiptDetail="Fetching your latest purchases…" />);
    expect(screen.getByRole("status", { name: "Fetching receipts" })).toBeInTheDocument();
    rerender(<MailOverview {...props} fetching={false} receiptDetail="Your latest receipts are ready." />);
    expect(screen.queryByRole("status", { name: "Fetching receipts" })).not.toBeInTheDocument();
    expect(screen.getByText("Your latest receipts are ready.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open receipts" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with One" }));
    expect(onOpenReceipts).toHaveBeenCalledOnce();
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Chat with One" }).querySelector("svg")).toBeNull();
  });
});
