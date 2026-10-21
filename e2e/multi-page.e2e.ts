import { expect, test } from "@playwright/test";

import { sites } from "./site.ts";

const s = sites.multiPage;
const domainUrl = s.domainUrl ?? "";
const aliasUrl = s.aliasUrl ?? "";

test.use({ baseURL: s.cdnUrl });

test("loads the home page with its assets", async ({ page }) => {
  const [styles, image] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/assets/styles.css"),
    page.waitForResponse((r) => new URL(r.url()).pathname === "/assets/images/deployment-map.svg"),
    page.goto("/"),
  ]);

  expect(styles.headers()["content-type"]).toContain("text/css");
  expect(image.headers()["content-type"]).toContain("image/svg+xml");
  await expect(page).toHaveTitle("Northstar Launch Ops");
  await expect(page.locator("html")).toHaveAttribute("data-page-state", "ready");
});

test("follows relative and absolute links with query and hash", async ({ page }) => {
  await page.goto("/");

  await page.locator('a[href="/pricing.html?plan=pro#compare"]').click();
  await expect(page).toHaveURL(`${s.cdnUrl}/pricing.html?plan=pro#compare`);

  await page.getByRole("link", { name: "Relative guide page" }).click();
  await expect(page).toHaveURL(`${s.cdnUrl}/guides/getting-started.html`);

  await page.getByRole("link", { name: "Open checklist" }).click();
  await expect(page).toHaveURL(`${s.cdnUrl}/guides/checklists/preflight.html`);
  await expect(page.locator("html")).toHaveAttribute("data-page-state", "ready");
});

for (const { path, title } of [
  { path: "/pricing.html", title: "Pricing - Northstar Launch Ops" },
  { path: "/contact.html", title: "Contact - Northstar Launch Ops" },
  { path: "/guides/", title: "Guides - Northstar Launch Ops" },
  {
    path: "/guides/checklists/preflight.html",
    title: "Preflight Checklist - Northstar Launch Ops",
  },
]) {
  test(`serves ${path}`, async ({ page }) => {
    const response = await page.goto(path);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(title);
  });
}

test("a directory link without a trailing slash lands on its index", async ({ page }) => {
  await page.goto("/");
  await page.locator('a[href="./guides"]').click();

  await expect(page).toHaveURL(`${s.cdnUrl}/guides/`);
  await expect(page).toHaveTitle("Guides - Northstar Launch Ops");
});

test("serves 404.html with 404 for missing pages and assets", async ({ page }) => {
  const response = await page.goto("/missing/deep/page");

  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("Not Found - Northstar Launch Ops");

  await page.getByRole("link", { name: "Back home" }).click();
  await expect(page).toHaveURL(`${s.cdnUrl}/`);

  const asset = await s.get(`${s.cdnUrl}/assets/missing.svg`);
  expect(asset.status).toBe(404);
  expect(asset.body).toContain("Not Found - Northstar Launch Ops");
});

for (const { path, status, target } of [
  { path: "/old", status: 301, target: "/pricing.html" },
  { path: "/old/", status: 301, target: "/pricing.html" },
  { path: "/blog/2024/hello", status: 302, target: "/guides/hello" },
  {
    path: "/handbook/checklists/preflight.html",
    status: 302,
    target: "/guides/checklists/preflight.html",
  },
  { path: "/moved", status: 301, target: "/contact.html" },
  { path: "/first", status: 302, target: "/pricing.html" },
  { path: "/temp", status: 302, target: "/contact.html" },
  { path: "/shadowed.html", status: 301, target: "/pricing.html" },
]) {
  test(`redirects ${path} with ${status} to ${target}`, async () => {
    const response = await s.get(`${s.cdnUrl}${path}`);

    expect(response.status).toBe(status);
    expect(response.headers.location).toBe(`${s.cdnUrl}${target}`);
  });
}

for (const { path, location } of [
  { path: "/guides?utm=e2e", location: "/guides/" },
  { path: "/guides/checklists", location: "/guides/checklists/" },
  { path: "/nope", location: "/nope/" },
]) {
  test(`adds the trailing slash to ${path}`, async () => {
    const response = await s.get(`${s.cdnUrl}${path}`);

    expect(response.status).toBe(301);
    expect(response.headers.location).toBe(`${s.cdnUrl}${location}`);
  });
}

test("leaves files and slash paths alone, also files without an extension", async () => {
  for (const path of ["/pricing.html", "/guides/", "/assets/styles.css", "/", "/LICENSE"]) {
    expect(await s.status(`${s.cdnUrl}${path}`), path).toBe(200);
  }
});

for (const { path, location } of [
  { path: "/old?u=1", location: "/pricing.html" },
  { path: "/handbook/checklists?u=1", location: "/guides/checklists?u=1" },
  { path: "/blog/2024/hello?u=1", location: "/guides/hello?u=1" },
]) {
  test(`query string on ${path} redirects to ${location}`, async () => {
    const response = await s.get(`${s.cdnUrl}${path}`);

    expect(response.headers.location).toBe(`${s.cdnUrl}${location}`);
  });
}

test("an absolute source URL redirects on its hostname only", async () => {
  const domain = await s.get(`${domainUrl}/domain-only`);
  expect(domain.status).toBe(302);
  expect(domain.headers.location).toBe(`${domainUrl}/pricing.html`);

  const http = await s.get(`${domainUrl.replace("https:", "http:")}/domain-only`);
  expect(http.status).toBe(302);

  expect((await s.get(`${s.cdnUrl}/domain-only`)).headers.location).toBe(
    `${s.cdnUrl}/domain-only/`,
  );
});

test("redirects when the country matches E2E_COUNTRY, the country this runs from", async () => {
  test.skip(!process.env.E2E_COUNTRY, "Set E2E_COUNTRY to the two-letter code of your location");

  for (const path of ["/geo-here", "/geo-many"]) {
    const response = await s.get(`${s.cdnUrl}${path}`);
    expect(response.status, path).toBe(302);
    expect(response.headers.location, path).toBe(`${s.cdnUrl}/pricing.html`);
  }
});

test("skips a redirect whose country does not match and a 200 rewrite", async () => {
  expect(await s.status(`${s.cdnUrl}/geo/`)).toBe(404);
  expect(await s.status(`${s.cdnUrl}/proxy/`)).toBe(404);
});

test("a relative redirect target stays on the requested hostname", async () => {
  const response = await s.get(`${domainUrl}/old`);

  expect(response.status).toBe(301);
  expect(response.headers.location).toBe(`${domainUrl}/pricing.html`);
});

test("sets headers from orbitpush.json, the last matching entry wins", async () => {
  const home = await s.get(`${s.cdnUrl}/`);
  expect(home.headers["x-frame-options"]).toBe("DENY");
  expect(home.headers["x-e2e-block"]).toBe("root");
  expect(home.headers["x-e2e-multi"]).toBe("a, b");

  const asset = await s.get(`${s.cdnUrl}/assets/styles.css`);
  expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

  const guides = await s.get(`${s.cdnUrl}/guides/`);
  expect(guides.headers["x-e2e-block"]).toBe("guides");

  const page = await s.get(`${s.cdnUrl}/guides/getting-started.html`);
  expect(page.headers["x-e2e-page"]).toBe("placeholder");
  expect(guides.headers["x-e2e-page"]).toBeUndefined();
});

test("headers: * inside a segment, Content-Type, Set-Cookie, case-insensitive joins", async () => {
  const css = await s.get(`${s.cdnUrl}/assets/styles.css`);
  expect(css.headers["x-e2e-css"]).toBe("yes");
  expect((await s.get(`${s.cdnUrl}/assets/app.js`)).headers["x-e2e-css"]).toBeUndefined();

  const aasa = await s.get(`${s.cdnUrl}/.well-known/apple-app-site-association`);
  expect(aasa.status).toBe(200);
  expect(aasa.headers["content-type"]).toBe("application/json");

  const pricing = await s.get(`${s.cdnUrl}/pricing.html`);
  expect(pricing.headers["set-cookie"]).toEqual(["e2e=1; Path=/"]);
  expect(pricing.headers["cache-control"]).toBe("max-age=0, no-cache");
  expect(pricing.headers["basic-auth"]).toBeUndefined();
  expect(pricing.headers.server).not.toBe("e2e");
  expect(Number(pricing.headers["content-length"] ?? pricing.body.length)).toBeGreaterThan(1);
});

test("headers also apply to 404 and redirect responses", async () => {
  const missing = await s.get(`${s.cdnUrl}/missing.html`);
  expect(missing.status).toBe(404);
  expect(missing.headers["x-frame-options"]).toBe("DENY");

  const redirect = await s.get(`${s.cdnUrl}/old`);
  expect(redirect.status).toBe(301);
  expect(redirect.headers["x-frame-options"]).toBe("DENY");
});

test("noindexes b-cdn.net but not the domain, whichever is cached first", async () => {
  const cdn = await s.get(`${s.cdnUrl}/pricing.html`);
  expect(cdn.headers["x-robots-tag"]).toBe("noindex");

  const domain = await s.get(`${domainUrl}/pricing.html`);
  expect(domain.status).toBe(200);
  expect(domain.headers["x-robots-tag"]).toBeUndefined();
});

test("redirects the alias to the domain with path and query", async () => {
  const alias = await s.get(`${aliasUrl}/pricing.html?plan=pro`);

  expect(alias.status).toBe(301);
  expect(alias.headers.location).toBe(`${domainUrl}/pricing.html?plan=pro`);
});
