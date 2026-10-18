import { expect, test } from "@playwright/test";

import { sites } from "./site.ts";

const s = sites.singleFile;

test.use({ baseURL: s.cdnUrl });

test("runs the inline script and reads the query string", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Launch Notes Express");
  await expect(page.locator("#status-title")).toHaveText("Inline JavaScript executed successfully");

  await page.getByRole("link", { name: "Reload with query" }).click();
  await expect(page).toHaveURL(`${s.cdnUrl}/?ref=single-file#status`);
  await expect(page.locator("#status-copy")).toHaveText(
    "Loaded with query parameter ref=single-file",
  );
});

test("navigates by hash without a document request", async ({ page }) => {
  await page.goto("/");

  const documents: string[] = [];
  page.on("request", (r) => r.resourceType() === "document" && documents.push(r.url()));

  await page.getByRole("link", { name: "Jump to checks" }).click();
  await expect(page).toHaveURL(`${s.cdnUrl}/#checks`);
  expect(documents).toEqual([]);
});

test("keeps mailto and tel links", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('a[href="mailto:hello@example.com"]')).toHaveCount(1);
  await expect(page.locator('a[href="tel:+491234567890"]')).toHaveCount(1);
});

test("without a domain, b-cdn.net is indexable and a missing path is 404", async () => {
  const home = await s.get(`${s.cdnUrl}/`);
  expect(home.headers["x-robots-tag"]).toBeUndefined();

  expect(await s.status(`${s.cdnUrl}/missing.html`)).toBe(404);
});

test("browsers revalidate every file while bunny.net's edge keeps caching it", async () => {
  const home = await s.get(`${s.cdnUrl}/`);
  expect(home.headers["cache-control"]).toBe("public, max-age=0");

  await expect
    .poll(async () => (await s.get(`${s.cdnUrl}/`)).headers["cdn-cache"], { timeout: 30_000 })
    .toBe("HIT");
});
