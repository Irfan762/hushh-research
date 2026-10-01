import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MailConnectedAccount, MailOverview } from "../../components/gmail/mail-overview";

function Fixture() {
  const [fetching, setFetching] = useState(true);
  const [action, setAction] = useState("");
  const [issue, setIssue] = useState(false);
  return <main className="app-page-shell mx-auto w-full max-w-[680px] bg-background px-6 py-8 text-foreground">
    <MailConnectedAccount onReconnect={() => setAction("reconnect")} onDisconnect={() => setAction("disconnect")} />
    <output data-testid="mail-action" className="sr-only">{action}</output>
    <MailOverview fetching={fetching} receiptIssue={issue} receiptCount={34} receiptDetail={issue ? "Sync failed. Please try again in a moment." : fetching ? "Fetching your latest purchases…" : "Your latest receipts are ready."} receiptUpdated="Last updated just now." onOpenChat={() => {}} />
    <button onClick={() => setFetching(false)}>Finish sync</button>
    <button onClick={() => { setFetching(false); setIssue(true); }}>Fail sync</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
