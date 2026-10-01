import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MailConnectedAccount, MailOverview } from "../../components/gmail/mail-overview";
import { GmailWorkspaceNavigation } from "../../components/gmail/gmail-workspace-navigation";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "../../components/app-ui/app-page-shell";
import { SurfaceStack } from "../../components/app-ui/surfaces";

function Fixture() {
  const [fetching, setFetching] = useState(true);
  const [action, setAction] = useState("");
  const [issue, setIssue] = useState(false);
  return <><AppPageShell width="reading" className="bg-background py-8 text-foreground lg:pt-[104px]">
    <AppPageHeaderRegion className="hidden lg:block">
      <p className="text-sm text-muted-foreground">Connected to your Mail</p>
    </AppPageHeaderRegion>
    <AppPageContentRegion>
    <SurfaceStack compact>
    <div className="hidden lg:block"><GmailWorkspaceNavigation value="overview" onValueChange={() => {}} /></div>
    <MailConnectedAccount onReconnect={() => setAction("reconnect")} onDisconnect={() => setAction("disconnect")} />
    <output data-testid="mail-action" className="sr-only">{action}</output>
    <MailOverview fetching={fetching} receiptIssue={issue} receiptCount={34} receiptDetail={issue ? "Sync failed. Please try again in a moment." : fetching ? "Fetching your latest purchases…" : "Your latest receipts are ready."} receiptUpdated="Last updated just now." onOpenChat={() => {}} />
    </SurfaceStack>
    </AppPageContentRegion>
    <button onClick={() => setFetching(false)}>Finish sync</button>
    <button onClick={() => { setFetching(false); setIssue(true); }}>Fail sync</button>
  </AppPageShell>
  <aside data-testid="desktop-bottom-clearance" aria-hidden="true" className="fixed inset-x-0 bottom-0 hidden h-32 bg-background/90 lg:block">Reserved voice and navigation space</aside>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
