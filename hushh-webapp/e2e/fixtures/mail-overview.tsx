import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MailConnectedAccount, MailOverview } from "../../components/gmail/mail-overview";

function Fixture() {
  const [fetching, setFetching] = useState(true);
  const [managing, setManaging] = useState(false);
  return <main className="app-page-shell mx-auto w-full max-w-[680px] bg-background px-6 py-8 text-foreground">
    <MailConnectedAccount managing={managing} onManage={() => setManaging(!managing)} />
    <div id="mail-management-panel" hidden={!managing}>Mail management</div>
    <MailOverview fetching={fetching} receiptDetail={fetching ? "Fetching your latest purchases…" : "Your latest receipts are ready."} receiptUpdated="Last updated just now." onOpenChat={() => {}} />
    <button onClick={() => setFetching(false)}>Finish sync</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
