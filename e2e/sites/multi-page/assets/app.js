document.documentElement.dataset.pageState = "loading";

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.pageState = "ready";

  const currentPage = document.body.dataset.page;
  const params = new URLSearchParams(window.location.search);
  const source = params.get("from") ?? params.get("source");

  if (!currentPage || !source) {
    return;
  }

  const notice = document.createElement("p");
  notice.className = "eyebrow";
  notice.textContent = `Opened from ${source} on ${currentPage}`;

  const main = document.querySelector("main");
  main?.prepend(notice);
});
