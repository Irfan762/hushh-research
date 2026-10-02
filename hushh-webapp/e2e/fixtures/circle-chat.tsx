import { createRoot } from "react-dom/client";
import { CircleChat } from "../../components/connect/circles/circle-chat";
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
  <h1 className="text-xl font-semibold">Weekend friends</h1>
  <CircleChat initialOpen circleName="Weekend friends" session={{ userId: "alice", circleId: "circle", vaultKey: "fixture", vaultOwnerToken: "fixture" }} />
</main>);
