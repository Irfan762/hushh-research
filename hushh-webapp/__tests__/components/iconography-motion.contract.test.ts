import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APPLICATION_ROOTS = ["app", "components", "hooks", "lib", "scripts", "src"];
const SOURCE_EXTENSIONS = new Set([".css", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

// Every glyph library an application file could reach for. Only the registry
// under components/icons may import one; everything else goes through
// `@/components/icons`, so one concept has one glyph app-wide.
const ICON_LIBRARY_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:lucide-react|@phosphor-icons\/react|react-icons|@heroicons\/react|@radix-ui\/react-icons|@tabler\/icons-react|@mui\/icons-material)(?:\/[^"']*)?["']/;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "node_modules"
        ? []
        : collectSourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  });
}

function isCanonicalIconImplementation(path: string): boolean {
  return path.includes("/components/icons/");
}

function findDirectIconLibraryImports(webappRoot: string): string[] {
  return APPLICATION_ROOTS.flatMap((root) => {
    let files: string[];
    try {
      files = collectSourceFiles(join(webappRoot, root));
    } catch {
      return [];
    }
    return files.flatMap((path) => {
      if (isCanonicalIconImplementation(path)) return [];
      return ICON_LIBRARY_IMPORT.test(readFileSync(path, "utf8"))
        ? [relative(webappRoot, path)]
        : [];
    });
  });
}

// Profile, and every nested screen reachable from it, draws row icons the
// way the Profile menu does: an authored registry glyph in its own colour on
// a transparent well (`iconTone="capability"`), never a coloured or gray tile.
const PROFILE_ROW_SURFACES = [
  "components/profile",
  "components/wallet-card",
  "app/one/profile",
];

function findTiledSettingsRows(source: string): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/<SettingsRow\b/g)) {
    let index = match.index;
    let depth = 0;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) break;
    }
    const tag = source.slice(match.index, index);
    const icon = tag.match(/\bicon=\{([^}]+)\}/)?.[1]?.trim();
    if (!icon) continue;
    if (!/\biconTone="capability"/.test(tag)) offenders.push(icon);
  }
  return offenders;
}

describe("application icon and motion contracts", () => {
  it("routes application-owned icon imports through the canonical registry", () => {
    expect(findDirectIconLibraryImports(process.cwd())).toEqual([]);
  });

  it("reports a direct icon-library import reintroduced outside the registry", () => {
    // Negative control: the scanner above would pass vacuously if it walked
    // nothing or matched nothing. Build a miniature app tree with one
    // offender, one registry file and one clean file, and require exactly the
    // offender back.
    const root = mkdtempSync(join(tmpdir(), "icon-import-control-"));
    try {
      mkdirSync(join(root, "components/icons"), { recursive: true });
      mkdirSync(join(root, "app/one"), { recursive: true });
      writeFileSync(
        join(root, "components/icons/registry.tsx"),
        'import { Bank } from "@phosphor-icons/react";\n',
      );
      writeFileSync(
        join(root, "app/one/page.tsx"),
        'import { Settings } from "lucide-react";\n',
      );
      writeFileSync(
        join(root, "components/clean.tsx"),
        'import { GearIcon } from "@/components/icons";\n',
      );
      expect(findDirectIconLibraryImports(root)).toEqual(["app/one/page.tsx"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("draws every Profile nested-route row icon with the Profile menu treatment", () => {
    const offenders = PROFILE_ROW_SURFACES.flatMap((surface) =>
      collectSourceFiles(join(process.cwd(), surface))
        .filter((path) => path.endsWith(".tsx"))
        .flatMap((path) =>
          findTiledSettingsRows(readFileSync(path, "utf8")).map(
            (icon) => `${relative(process.cwd(), path)}: ${icon}`,
          ),
        ),
    );
    expect(offenders).toEqual([]);

    // Negative control: a tiled row, and a row with no tone at all (which
    // falls back to the gray tile), must both be reported.
    expect(
      findTiledSettingsRows(
        '<SettingsRow icon={KeyRound} iconTone="blue" title="Vault" />\n' +
          '<SettingsRow icon={Laptop} title="Device" />\n' +
          '<SettingsRow icon={VaultRowIcon} iconTone="capability" title="Ok" />',
      ),
    ).toEqual(["KeyRound", "Laptop"]);

    // The Account screen's iOS tile rules once painted a tile behind the
    // capability Wallet row and shrank its glyph to 17px. They must exclude
    // capability rows, and nested screens must share the menu's glyph size.
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toContain(
      '.profile-account-content [data-slot="settings-row-icon"]:not([data-icon-tone="capability"]):not([data-icon-tone="transparent"]) {',
    );
    expect(css).not.toMatch(
      /\.profile-account-content \[data-slot="settings-row-icon"\] \{/,
    );
    expect(css).toMatch(
      /\[data-profile-stack-content="true"\] \[data-icon-tone="capability"\] svg,[\s\S]*?height: 28px !important;\s+width: 28px !important;/,
    );
  });

  it("keeps the compatibility facade on official native Phosphor geometry", () => {
    const source = readFileSync(
      join(process.cwd(), "components/icons/legacy-ui-icons.tsx"),
      "utf8",
    );

    expect(source).toContain('import * as Phosphor from "@phosphor-icons/react"');
    expect(source).toContain('defaultWeight: IconWeight = "duotone"');
    expect(source).toContain('Phosphor.CircleNotch, "regular"');
    expect(source).toContain(
      'export const MoreHorizontal = createCanonicalIcon(Phosphor.DotsThree, "regular");',
    );
    expect(source).toContain("forwardRef<SVGSVGElement");
    expect(source).toContain('data-canonical-icon="true"');

    const uiIcons = readFileSync(
      join(process.cwd(), "components/icons/ui/ui-icons.tsx"),
      "utf8",
    );
    const detailIcons = readFileSync(
      join(process.cwd(), "components/icons/ui/detail-icons.tsx"),
      "utf8",
    );
    expect(uiIcons).toContain('weight = "regular"');
    expect(uiIcons).toContain(
      'export function DotsThreeIcon({\n  size = "1em",\n  weight = "regular",',
    );
    expect(detailIcons).toContain(
      'ArrowsClockwiseIcon({ weight = "regular"',
    );
    expect(detailIcons).toContain('SpinnerGapIcon({ weight = "regular"');
    expect(detailIcons).toContain('data-canonical-icon="true"');
    expect(uiIcons).toContain('data-canonical-icon="true"');

    const globals = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    expect(globals).toContain('svg[data-canonical-icon="true"]');
    expect(globals).toContain("background-color: transparent !important;");
  });
});
