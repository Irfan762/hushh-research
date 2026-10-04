# iOS Native Controls and Liquid Glass

Implementation owner: frontend/native shell. Reviewed against source on 2026-10-03.
This is a component inventory and bounded adoption reference, not a claim that every
candidate is implemented or released.

## Visual Context

The package [docs index](README.md#visual-map) owns the overview. Native controls
remain presentation adapters below the existing React action and routing owners.
One Capacitor host retains the active document; adopting a control does not create
another navigation stack, WebView, session, or information store.

## Current Implementation

- [HushhNativeNavigationPlugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift)
  presents a standard UIKit `UITabBar` on iOS 26+. It does not use SwiftUI `TabView`
  or `UITabBarController`; controller-only Search, minimization and accessory
  behaviors are not implemented by this standalone bar.
- [The bridge](../lib/capacitor/native-navigation.ts) passes bounded presentation
  metadata. [Navbar](../components/navbar.tsx) retains destination/action authority;
  [AppBottomShell](../components/app-ui/app-bottom-shell.tsx) reserves measured
  native geometry and retains the existing voice control. Web, Android, older iOS
  and unsupported wrappers keep the DOM navigation path.
- Document, revision, interaction, privacy and tap-sequence checks reject stale
  native requests. Keyboard, app privacy and registered web overlays isolate the
  bar. This isolation is navigation-specific, not a universal native-modal manager.
- [ProfileAvatarEditor](../components/profile/profile-avatar-editor.tsx) opens an
  in-place DOM photo preview with close and existing Photo options. The preview
  itself neither writes a photo nor opens a picker.
- [The global Search host](../components/kai/kai-command-bar-global.tsx) is mounted
  on Chat by [Providers](../app/providers.tsx). Native Search opens that existing
  palette; it is not an independent search route or native result engine.

Apple recommends standard system controls and reserves Liquid Glass primarily for
the interactive layer above content. Native material is not equivalent to adding
CSS backdrop blur to a web card. Prefer the existing UIKit bridge over introducing
a second framework solely for appearance. See [Apple's UIKit adoption guidance](https://developer.apple.com/videos/play/wwdc2025/284/).
SwiftUI is an option for a bounded new native view, not a requirement to rewrite
React content; see [Apple's SwiftUI adoption guidance](https://developer.apple.com/videos/play/wwdc2025/323/).

## Shared Component Inventory

Priority is a recommendation based on the existing authority seam, not delivery
status. **Next** means a small control-level candidate; **conditional** means a
separate interaction contract and proof are needed; **retain** means no glass
conversion is recommended. Feature instances should reuse these owners rather
than acquire separate native implementations.

| Component family and source owner | Current presentation | Native fit / recommendation |
| --- | --- | --- |
| Bottom navigation — [Navbar](../components/navbar.tsx), [native plugin](../ios/App/App/Plugins/HushhNativeNavigationPlugin.swift) | UIKit on supported iOS; DOM fallback | Implemented. Keep standard appearance and React selection authority. |
| Top bar, back, Profile — [TopAppBar](../components/app-ui/top-app-bar.tsx), [ShellActionSurface](../components/app-ui/shell-action-surface.tsx) | DOM shell controls | Next: bounded toolbar buttons using UIKit system controls. Whole native bar is conditional; retain existing back/Profile actions and replace, not duplicate, clearance. |
| Shell option menus — [TopShellDropdown](../components/app-ui/top-shell-dropdown.tsx) | DOM anchored menu/popover | Next: short native action menu, retaining trigger, selection and focus return. |
| Section action menus — [ActionMenu](../components/app-ui/action-menu.tsx) | Mobile Sheet; desktop dropdown | Next: native menu/action-sheet adapter for serializable item IDs and labels. Arbitrary React labels stay DOM. Preserve disabled/busy state and separate destructive confirmation. |
| Agent/voice controls — [AgentBar](../components/agent/agent-bar.tsx), [OneVoiceControl](../components/one-voice/one-voice-control.tsx) | DOM controls over existing runtime providers | Conditional: launcher/cancel chrome only. Keep tap/hold, slide-to-cancel, recording, readiness and task state with existing owners; retain transcript/waveform content. |
| Search field and close — [KaiCommandPalette](../components/kai/kai-command-palette.tsx), [SearchClearButton](../components/app-ui/search-clear-button.tsx) | DOM controlled palette | Conditional: native search chrome. Existing query, results and action runtime remain authoritative; prove IME, keyboard and dismissal before replacing the field. |
| Chat history and connectors — [AgentHistorySidebar](../components/agent/agent-history-sidebar.tsx), [AgentConnectionsDrawer](../components/agent/agent-connections-drawer.tsx) | DOM panels and shared overlays | Conditional: header/close/action controls first. Keep chat list, connector forms, tools and credential handling in existing owners. Do not remount the conversation. |
| Profile and photo preview — [ProfilePane](../components/app-ui/profile-pane.tsx), [ProfileAvatarEditor](../components/profile/profile-avatar-editor.tsx) | DOM Sheet / Dialog | Conditional: header/back/close/options chrome. Retain URL-backed Profile state and photo content; picker authority already has a native adapter. |
| Record detail — [AdaptiveDetailSurface / SettingsDetailPanel](../components/app-ui/settings-ui.tsx) | Responsive DOM Sheet/Drawer/Dialog | Conditional: shared header controls. Arbitrary body/footer, editing and scrolling prevent a mechanical native transport replacement. |
| Sheets, dialogs, drawers — [Sheet](../components/ui/sheet.tsx), [Dialog](../components/ui/dialog.tsx), [Drawer](../components/ui/drawer.tsx) | Radix / Vaul portals | Conditional: opt-in native presentation for one bounded surface, not global primitive substitution. Preserve controlled open state, drag/scroll handoff and dismissal policy. |
| Menus, popovers and selection — [DropdownMenu](../components/ui/dropdown-menu.tsx), [Popover](../components/ui/popover.tsx), [Select](../components/ui/select.tsx), [Combobox](../components/ui/combobox.tsx) | DOM overlays and option lists | Next for short nonsecret action lists; conditional for searchable/edited selection. Modal and nonmodal semantics must remain distinct. |
| Alerts and notifications — [AlertDialog](../components/ui/alert-dialog.tsx), [Alert](../components/ui/alert.tsx), [Sonner](../components/ui/sonner.tsx) | DOM confirmation / inline status / toast | Conditional for simple confirmations. Keep asynchronous acknowledgement and cancellation; retain nonblocking status instead of converting every toast to a modal. |
| Route/local tabs — [TopShellTabs](../components/app-ui/top-shell-tabs.tsx), [WorkspaceTopTabs](../components/app-ui/workspace-top-tabs.tsx), [SegmentedTabs](../lib/morphy-ux/ui/segmented-tabs.tsx), [SwipeViews](../lib/morphy-ux/ui/swipe-views.tsx) | DOM selectors and mounted content pager | Conditional: native segmented selector. Route registry/query or local state remains the selected-value owner. Preserve swipe settlement and mounted panes; no second navigation controller. |
| Buttons, groups and chips — [Button](../components/ui/button.tsx), [ButtonGroup](../components/ui/button-group.tsx), [Morphy button](../lib/morphy-ux/button.tsx) | DOM form/action controls | Selective toolbar candidates only. Retain ordinary form buttons, filters and content actions; no global native button replacement. |
| Fields, input groups, inputs, textareas, checkbox/radio/switch | [Shared UI primitives](../components/ui/) | Retain form semantics. A bounded nonsecret native selector is conditional; glass is not a reason to move secret or arbitrary forms into Swift. |
| Cards, tables, charts, avatars, badges, breadcrumbs, separators and typography | [Shared UI primitives](../components/ui/) and feature bodies | Retain content-first surfaces. Chat responses, holdings, Memory and consent records are not glass panels. |
| Accordion, collapsible, carousel, pagination, sidebar and scroll area | [Shared UI primitives](../components/ui/) | Retain content/navigation semantics unless an individually justified native container is adopted. Do not change scroll ownership with a cosmetic primitive swap. |
| Command, tooltip, keyboard hints, empty/loading/progress/status | [Shared UI primitives](../components/ui/) | Retain existing semantic feedback and keyboard/accessibility behavior; do not add independent native overlays for every state. |

### Pickers and OS Presentations

| Existing owner | Current implementation | Recommendation |
| --- | --- | --- |
| [Avatar capture](../lib/profile/avatar-capture.ts) | Capacitor Camera; web file fallback | Already native on iOS. Reuse permissions, cancellation and image normalization; do not create another photo picker. |
| [Share link](../lib/share/share-link.ts), [native download](../lib/utils/native-download.ts), [wallet share](../components/wallet-card/wallet-card-share.ts) | Capacitor Share / system activity controller | Already native. Dismiss any prior native presentation before Share; keep existing export and sharing authority. |
| [Document date range](../components/consent/mobile-document-date-range.tsx) | Custom calendar and HTML month/year selection | Conditional date-picker adapter; preserve calendar dates, two-stage range selection and invalid-end clearing. |
| [Document file request](../components/consent/document-file-request.tsx), [holding editor](../components/kai/modals/edit-holding-modal.tsx) | HTML date input, WebKit-mediated picker | Reuse first. Existing direct user activation is intentional; not evidence of an app-owned `UIDatePicker`. |
| [Location duration](../components/one-location/redesign/duration-wheel-picker.tsx) | Custom hour/minute wheels plus open-ended choice | Conditional native duration selector, not a time-of-day picker. Preserve value units and “Until I stop.” |
| [Portfolio import](../components/kai/views/portfolio-import-view.tsx), [Circle chat](../components/connect/circles/circle-chat.tsx) | HTML file input, WebKit-mediated chooser | Reuse accepted types, cancellation and processing/upload owners before introducing a document-picker bridge. |

Existing picker adapters are source-verified; this navigation lane did not
physically accept every picker or its exact OS appearance.

### Feature Consumers

Consent/document reviews, contact invitations and selection, Circle/location
decisions, portfolio/RIA details, wallet confirmations and model/voice selection
inherit the shared owners above. Model, connection, wallet and consent decisions
are authority-bearing actions, not merely visual menu choices. An adapter must
never convert selecting a row into an unreviewed provider write or information share.

## Graceful Adoption Boundary

1. Start with top-bar action buttons and short section/option menus. Adopt one
   shared owner with a bounded caller before migrating its feature consumers.
2. Evaluate Profile/detail header controls and local segmented selectors next.
   Search, voice controls and full sheet/pane transport require dedicated proofs;
   they are not bundled into a styling change.
3. Use standard UIKit controls first. `UINavigationBar`, `UIToolbar`, system menu
   and presentation APIs have native behavior; custom controls may use
   `UIButton.Configuration.glass()` or `UIGlassEffect` only when justified.
   SwiftUI alternatives include system toolbars, menus and presentation APIs;
   custom `glassEffect`/`GlassEffectContainer` are selective options, not app-wide
   defaults. These are API candidates, not current app implementations.
4. Each adapter needs capability detection and a DOM fallback. Keep web/Android
   unchanged, preserve unsupported iOS behavior and remove duplicate accessibility
   controls and layout reservation when native presentation is active.
5. Native callbacks must bind to the current document, interaction/presentation
   and privacy state. Revalidate the owning action before execution; cancel stale
   selections after dismissal, owner changes, backgrounding or locking. Never
   pass vault secrets or protected response bodies as presentation metadata.
6. Explicitly isolate sibling native controls when a DOM overlay opens. CSS
   z-index, DOM `inert` and Radix focus traps do not isolate UIKit siblings. Keep
   intentional nonmodal map surfaces nonmodal and restore focus on dismissal.
7. Preserve one active Capacitor document. Do not host arbitrary React content in
   a second WebView or relaunch a route to fake session continuity. A future
   SwiftUI view must remain a bounded presentation child, not a second router.
8. Keep the privacy shield opaque. Vault, credential, passphrase, OTP and
   runtime-secret surfaces are excluded from decorative glass adoption. Preserve
   existing OS-auth and secure-entry boundaries.
9. Do not restore a decorative bottom fade or add default spring/bounce effects
   to DOM controls. Native system motion is a separate OS behavior; respect
   reduced motion and reduced transparency rather than layering custom motion.

## Verification and Promotion

Physical iPhone evidence on 2026-10-03 covers the native Chat/One/Connect/Feed
journey, return to selected Chat, Chat-drawer isolation, Search opening/isolation/
dismissal/restoration, and photo-preview open/close without mutation. Both
attach-only tests in [AppUITests](../ios/App/AppUITests/AppUITests.swift) passed in
the existing unlocked session. The accessibility proof finds one identified
Capacitor host and its nested nodes; it is not a WKWebView pointer-identity proof.

The candidate was locally built and installed with production-targeted assets.
No cloud deployment, TestFlight or App Store acceptance is implied. Native state,
focused frontend contracts, typecheck and package verification passed. Exact
runtime evidence belongs in the ignored verification handoff, not screenshots of
protected content in canonical docs.

Before promoting another family, require the nearest focused contract plus its
negative control, same-session physical interaction proof, focus/VoiceOver and
Dynamic Type checks, light/dark contrast, reduced motion/transparency, keyboard
and safe-area geometry, rotation and iPad adaptation, nested-overlay isolation,
and restoration of the DOM fallback. Native visual appearance and explicit
physical keyboard/accessibility checks remain outstanding for this candidate;
source coverage or a successful build alone is not visual acceptance.

The current [ambient chrome mask](../components/app-ui/ambient-chrome-mask.tsx)
and scroll-edge behavior have existing design contracts. Changing them alongside
a native top bar requires an explicit, independently verified design change, not
an automatic material substitution.
