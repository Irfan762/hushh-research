import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProfilePane } from "@/components/app-ui/profile-pane";

const vault = vi.hoisted(() => ({ isVaultUnlocked: false }));
const url = vi.hoisted(() => ({
  query: "profile_pane=1&profile_panel=preferences",
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(url.query),
}));
vi.mock("@/components/profile/profile-workspace-page", () => ({
  ProfilePage: ({ paneLocation }: { paneLocation?: { panel: string | null } }) => (
    <div data-testid="pane-body" data-panel={paneLocation?.panel ?? "root"}>
      Preferences content
    </div>
  ),
}));

it("defers a URL-requested pane until unlock and removes it immediately on relock", () => {
  const onOpenChange = vi.fn();
  const view = render(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.queryByTestId("profile-pane")).toBeNull();
  vault.isVaultUnlocked = true;
  // The real vault context causes memoized ProfilePane to update when its
  // value changes. This test uses a plain mocked hook, so change a prop to
  // model that context-driven render without removing the production memo.
  view.rerender(
    <ProfilePane
      open
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
    />,
  );
  expect(screen.getByText("Preferences content")).toBeTruthy();
  vault.isVaultUnlocked = false;
  view.rerender(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.queryByTestId("profile-pane")).toBeNull();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("anchors the custom close button and keeps the nested back control separate", () => {
  vault.isVaultUnlocked = true;
  const onOpenChange = vi.fn();

  render(<ProfilePane open onOpenChange={onOpenChange} />);

  const close = screen.getByRole("button", { name: "Close Profile" });
  expect(close.style.right).toBe(
    "max(1rem, env(safe-area-inset-right, 0px))",
  );
  expect(close.getAttribute("style")).not.toContain("left:");
  expect(screen.getByRole("button", { name: "Back in Profile" })).toBeTruthy();

  fireEvent.click(close);
  expect(onOpenChange).toHaveBeenCalledWith(false);

  vault.isVaultUnlocked = false;
});

it("holds the open location while the pane closes, so the exit is one motion", () => {
  // Closing drops the pane query, which also resets the URL location to the
  // root. The sheet keeps its content mounted for the exit slide; if that
  // content followed the URL, the header retitled to "Profile" and the inner
  // stack slid back while the sheet slid out.
  vault.isVaultUnlocked = true;
  url.query = "profile_pane=1&profile_panel=preferences";
  const onOpenChange = vi.fn();
  const view = render(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.getByText("Appearance & preferences")).toBeTruthy();

  url.query = "";
  view.rerender(
    <ProfilePane open onOpenChange={(nextOpen) => onOpenChange(nextOpen)} />,
  );
  expect(screen.getByText("Appearance & preferences")).toBeTruthy();
  expect(screen.queryByText("Profile", { selector: "h2" })).toBeNull();
  expect(screen.getByTestId("pane-body").dataset.panel).toBe("preferences");

  // Reopening follows the URL again.
  url.query = "profile_pane=1";
  view.rerender(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.getByTestId("pane-body").dataset.panel).toBe("root");

  vault.isVaultUnlocked = false;
  url.query = "profile_pane=1&profile_panel=preferences";
});
