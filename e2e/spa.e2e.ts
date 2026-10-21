import { expect, test } from "@playwright/test";

import { sites } from "./site.ts";

const s = sites.spa;
const HOME = "One HTML entry, multiple client routes.";

test.use({ baseURL: s.cdnUrl });

test("loads the module app, import map and local JSON", async ({ page }) => {
  const [app, data] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/assets/app.js"),
    page.waitForResponse((r) => new URL(r.url()).pathname === "/data/projects.json"),
    page.goto("/"),
  ]);

  expect(app.headers()["content-type"]).toContain("javascript");
  expect(data.headers()["content-type"]).toContain("application/json");
  await expect(page.getByRole("heading", { name: HOME })).toBeVisible();
  await expect(page.locator("p").filter({ hasText: "Data status:" })).toContainText("ready");
});

test("navigates with pushState and history without document requests", async ({ page }) => {
  await page.goto("/");

  const documents: string[] = [];
  page.on("request", (r) => r.resourceType() === "document" && documents.push(r.url()));

  await page.getByRole("link", { name: "Open projects" }).click();
  await expect(page.getByRole("heading", { name: "Published projects" })).toBeVisible();

  await page.getByRole("link", { name: "Timeline" }).first().click();
  await expect(page).toHaveURL(`${s.cdnUrl}/projects/alpha?view=timeline#deploy`);

  await page.goBack();
  await expect(page).toHaveURL(`${s.cdnUrl}/projects`);
  expect(documents).toEqual([]);
});

for (const { path, heading } of [
  { path: "/projects", heading: "Published projects" },
  { path: "/projects/alpha?view=timeline#deploy", heading: "Alpha Campaign" },
  { path: "/settings", heading: "Client-side route with no matching HTML file" },
]) {
  test(`serves index.html with 200 for a deep link to ${path}`, async ({ page }) => {
    const response = await page.goto(path);

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  });
}

test("renders the client fallback for an unknown route", async ({ page }) => {
  const response = await page.goto("/unknown-route");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /No in-app match for/ })).toContainText(
    "/unknown-route",
  );
});

test("a missing path with an extension is 404 with index.html, not 404.html", async () => {
  const index = await s.get(`${s.cdnUrl}/`);

  for (const path of ["/assets/missing.json", "/missing.html"]) {
    const response = await s.get(`${s.cdnUrl}${path}`);
    expect(response.status, path).toBe(404);
    expect(response.body.trim(), path).toBe(index.body.trim());
  }
});

test("redirects run before SPA mode", async () => {
  const response = await s.get(`${s.cdnUrl}/old-projects`);

  expect(response.status).toBe(301);
  expect(response.headers.location).toBe(`${s.cdnUrl}/projects`);
});

test("trailingSlash never strips the slash, except with a query string", async () => {
  const response = await s.get(`${s.cdnUrl}/projects/alpha/`);
  expect(response.status).toBe(301);
  expect(response.headers.location).toBe(`${s.cdnUrl}/projects/alpha`);

  expect(await s.status(`${s.cdnUrl}/projects/?view=timeline`)).toBe(200);
  expect(await s.status(`${s.cdnUrl}/projects`)).toBe(200);
});

test("headers apply to the SPA fallback for a client route", async () => {
  const response = await s.get(`${s.cdnUrl}/projects`);

  expect(response.status).toBe(200);
  expect(response.headers["x-e2e-spa"]).toBe("yes");
});
