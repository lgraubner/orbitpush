import { h, render } from "preact";
import htm from "htm";
import { useEffect, useState } from "preact/hooks";

const html = htm.bind(h);

const routes = [
  { label: "Overview", href: "/" },
  { label: "Projects", href: "/projects" },
  { label: "Alpha", href: "/projects/alpha?view=timeline#deploy" },
  { label: "Settings", href: "/settings" },
];

const dataUrl = "/data/projects.json";

function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [search, setSearch] = useState(window.location.search);
  const [hash, setHash] = useState(window.location.hash);
  const [projects, setProjects] = useState([]);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const onPopState = () => {
      setPath(window.location.pathname);
      setSearch(window.location.search);
      setHash(window.location.hash);
    };

    const onClick = (event) => {
      const link = event.target.closest("a");

      if (!link) {
        return;
      }

      if (
        link.target === "_blank" ||
        link.hasAttribute("download") ||
        link.dataset.native === "true"
      ) {
        return;
      }

      const url = new URL(link.href, window.location.href);

      if (url.origin !== window.location.origin) {
        return;
      }

      event.preventDefault();
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
      onPopState();
    };

    window.addEventListener("popstate", onPopState);
    document.addEventListener("click", onClick);

    return () => {
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("click", onClick);
    };
  }, []);

  useEffect(() => {
    let active = true;

    fetch(dataUrl)
      .then((response) => response.json())
      .then((payload) => {
        if (!active) {
          return;
        }

        setProjects(payload.projects);
        setStatus("ready");
      })
      .catch(() => {
        if (!active) {
          return;
        }

        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  const params = new URLSearchParams(search);
  const currentView = params.get("view") ?? "overview";
  const currentProjectSlug = path.startsWith("/projects/") ? path.slice("/projects/".length) : null;
  const currentProject = projects.find((project) => project.slug === currentProjectSlug) ?? null;

  return html`
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="/">Signal Board SPA</a>
        <nav class="nav-links" aria-label="SPA navigation">
          ${routes.map((route) => html`<a href=${route.href}>${route.label}</a>`)}
          <a data-native="true" href="/index.html">Explicit index file</a>
        </nav>
      </header>
      ${renderRoute({
        currentProject,
        currentView,
        hash,
        path,
        projects,
        search,
        status,
      })}
    </div>
  `;
}

function renderRoute({ currentProject, currentView, hash, path, projects, search, status }) {
  if (path === "/") {
    return html`
      <section class="hero">
        <article class="route-card">
          <p class="eyebrow">SPA overview</p>
          <h1>One HTML entry, multiple client routes.</h1>
          <p class="lede">
            This demo is intentionally small, but it still performs real client routing, fetches
            local JSON, and preserves query and hash state.
          </p>
          <div class="button-row">
            <a class="button button-primary" href="/projects">Open projects</a>
            <a class="button button-secondary" href="/projects/beta?view=preview#logs"
              >Open deep route</a
            >
            <a class="button button-secondary" data-native="true" href="/assets/missing.json"
              >Test missing asset</a
            >
          </div>
        </article>
        <aside class="panel">
          <p class="eyebrow">Runtime state</p>
          <p><strong>Data status:</strong> ${status}</p>
          <p><strong>Current path:</strong> <code>${path}</code></p>
          <p><strong>Query view:</strong> <code>${currentView}</code></p>
          <p><strong>Hash:</strong> <code>${hash || "(none)"}</code></p>
        </aside>
      </section>
      <section class="grid">
        <article class="panel">
          <h2>Coverage</h2>
          <p class="muted">
            Test direct loads of <code>/projects</code>, <code>/projects/alpha</code>, and
            <code>/settings</code> to confirm SPA fallback works.
          </p>
        </article>
        <article class="panel">
          <h2>What is local?</h2>
          <p class="muted">
            Styles, the app module, <code>404.html</code>, and project data all live inside the
            uploaded project bundle.
          </p>
        </article>
      </section>
    `;
  }

  if (path === "/projects") {
    return html`
      <section class="route-card">
        <p class="eyebrow">Projects route</p>
        <h2>Published projects</h2>
        <p class="muted">
          This route renders after a client-side navigation or a direct deep link if the server
          falls back to <code>index.html</code>.
        </p>
      </section>
      <section class="grid">
        ${projects.map(
          (project) => html`
            <article class="project-card" data-state=${project.state}>
              <span class="pill">${project.state}</span>
              <h3>${project.name}</h3>
              <p>${project.summary}</p>
              <div class="button-row">
                <a href=${`/projects/${project.slug}?view=timeline#deploy`}>Timeline</a>
                <a href=${`/projects/${project.slug}?view=preview#notes`}>Preview</a>
              </div>
            </article>
          `,
        )}
      </section>
    `;
  }

  if (currentProject) {
    return html`
      <section class="hero">
        <article class="route-card">
          <p class="eyebrow">Project route</p>
          <h1>${currentProject.name}</h1>
          <p class="lede">${currentProject.summary}</p>
          <div class="meta-row">
            <span class="pill">${currentProject.state}</span>
            <span><strong>View:</strong> ${currentView}</span>
            <span><strong>Hash:</strong> ${hash || "(none)"}</span>
          </div>
          <div class="button-row">
            <a class="button button-primary" href="/projects">Back to projects</a>
            <a
              class="button button-secondary"
              href=${`/projects/${currentProject.slug}?view=preview#notes`}
              >Switch query/hash</a
            >
            <a class="button button-secondary" href="/settings">Open settings route</a>
          </div>
        </article>
        <aside class="panel">
          <p class="eyebrow">Requested URL</p>
          <pre>${`${path}${search}${hash}`}</pre>
        </aside>
      </section>
    `;
  }

  if (path === "/settings") {
    return html`
      <section class="route-card">
        <p class="eyebrow">Settings route</p>
        <h2>Client-side route with no matching HTML file</h2>
        <p class="muted">
          Directly loading <code>/settings</code> should still render this view in SPA mode.
        </p>
        <div class="button-row">
          <a class="button button-primary" href="/">Back home</a>
          <a class="button button-secondary" href="/projects/alpha?view=timeline#deploy"
            >Deep-link test</a
          >
        </div>
      </section>
    `;
  }

  return html`
    <section class="route-card">
      <p class="eyebrow">Client route fallback</p>
      <h2>No in-app match for <code>${path}</code></h2>
      <p class="muted">
        The SPA shell rendered, so OrbitPush routed the request to
        <code>index.html</code>. The client router then produced its own fallback.
      </p>
      <div class="button-row">
        <a class="button button-primary" href="/">Back home</a>
      </div>
    </section>
  `;
}

render(html`<${App} />`, document.querySelector("#app"));
