import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitProductFont, productFontStyle, stripAppFontFaces } from "./fixtures/product-font";

// Production React component and CSS; fixture replaces only the service port.
// Protocol/crypto proofs are separate and do not claim this adapter is a backend.
let script: string;
let css: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const { build } = await import("vite");
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({});
  const candidates = new Set<string>();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "circle-chat-layout-"));
  try {
    await build({ configFile: false, logLevel: "error", oxc: { jsx: { runtime: "automatic", development: false } },
      plugins: [{ name: "fixture-css", transform(source, id) {
        if (!id.includes("node_modules") && /\.[tj]sx?$/.test(id)) for (const candidate of scanner.scanFiles([{ content: source, extension: "tsx" }])) candidates.add(candidate);
      } }],
      resolve: { alias: [
        { find: "@/lib/services/circle-chat-service", replacement: path.join(root, "e2e/fixtures/circle-chat-boundary.ts") },
        { find: "@/lib/services/api-service", replacement: path.join(root, "e2e/fixtures/circle-chat-http-boundary.ts") },
        { find: "@", replacement: root },
      ] }, define: { "process.env.NODE_ENV": JSON.stringify("production"), "process.env": "{}" },
      build: { outDir, emptyOutDir: false, lib: { entry: path.join(root, "e2e/fixtures/circle-chat.tsx"), name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" } },
    });
    script = fs.readFileSync(path.join(outDir, "fixture.js"), "utf8");
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
  const { compile } = await import("tailwindcss");
  const compiler = await compile(fs.readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/^@source\s+[^;]+;\s*$/gm, ""), {
    base: path.join(root, "app"), loadStylesheet: async (id, base) => {
      const file = id === "tailwindcss" ? path.join(root, "node_modules/tailwindcss/index.css") : id === "tw-animate-css" ? path.join(root, "node_modules/tw-animate-css/dist/tw-animate.css") : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, "utf8") };
    },
  });
  css = stripAppFontFaces(compiler.build([...candidates])) + productFontStyle();
});
async function mount(page: Page, dark = false) {
  await page.route("http://localhost/circle-chat-fixture", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto("http://localhost/circle-chat-fixture");
  await page.addScriptTag({ content: script });
  await awaitProductFont(page);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

for (const width of [320, 393, 430, 768, 1440]) {
  test(`fits long messages and a bounded keyboard composer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mount(page, width === 430);
    await page.getByRole("textbox", { name: "Message" }).fill("A long draft\n".repeat(120));
    await page.evaluate(() => document.documentElement.style.setProperty("--kb-height", "300px"));
    const geometry = await page.evaluate(() => {
      const editor = document.querySelector("textarea")!;
      return { pageWidth: document.documentElement.scrollWidth, width: innerWidth, editorHeight: editor.getBoundingClientRect().height,
        targets: [...document.querySelectorAll('button[aria-label="Choose image"],button[aria-label="Send message"]')].map((element) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })) };
    });
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.editorHeight).toBeLessThanOrEqual(129);
    for (const target of geometry.targets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: test.info().outputPath(`circle-chat-${width}.png`), fullPage: true });
  });
}

test("preserves a timed-out send across collapse and opens images inside the app", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 844 });
  await mount(page);
  await page.evaluate(() => { (window as unknown as { chatFixture: { failNext: boolean } }).chatFixture.failNext = true; });
  await page.getByRole("textbox", { name: "Message" }).fill("Hello friends");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(/Delivery is unconfirmed/)).toBeVisible();
  await page.getByRole("button", { name: /Circle chat/ }).click();
  await page.getByRole("button", { name: /Circle chat/ }).click();
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  const sends = await page.evaluate(() => (window as unknown as { chatFixture: { sends: unknown[] } }).chatFixture.sends);
  expect(sends).toHaveLength(2); expect(sends[0]).toEqual(sends[1]);
  await page.getByRole("button", { name: "View image", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open shared image" })).toBeVisible();
  await expect.poll(() => page.getByLabel("Circle messages", { exact: true }).evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(8);
  await page.getByRole("button", { name: "Open shared image" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(393);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
