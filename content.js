// Runs at document_start on every top-level page. When Edge is about to show a
// PDF, replace its built-in viewer with ours, embedded in a full-page frame, so
// the address bar keeps the PDF's own URL (web and local files alike).
(() => {
  if (document.contentType !== "application/pdf") return;

  const url = location.href;
  const BYPASS_KEY = "pdfCitationHover.openInEdge";

  // "Open in Edge's built-in viewer" was chosen: let Edge show this one load.
  try {
    if (sessionStorage.getItem(BYPASS_KEY) === url) {
      sessionStorage.removeItem(BYPASS_KEY);
      return;
    }
  } catch {}

  const viewerOrigin = new URL(chrome.runtime.getURL("")).origin;
  const viewerSrc = `${chrome.runtime.getURL("viewer.html")}?file=${encodeURIComponent(url)}`;
  let name = location.pathname.split("/").pop() || location.hostname;
  try { name = decodeURIComponent(name); } catch {}

  // Replace the page before Edge's viewer starts.
  // (Don't call window.stop() here: at document_start it leaves the page unable to paint.)
  document.open();
  document.write(
    "<!doctype html><html><head><meta charset='utf-8'><title></title>" +
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#e8e8e8}" +
    "@media (prefers-color-scheme:dark){html,body{background:#1f1f1f}}" +
    "iframe{border:0;width:100%;height:100%;display:block}</style></head><body></body></html>"
  );
  document.close();

  // Tab title and icon; like Edge, "*" and a different icon mean unsaved changes.
  const ICON = "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
    "<path d='M3.5 1.5h6l3 3v10h-9z' fill='#fff' stroke='#c4314b'/>" +
    "<path d='M9.5 1.5v3h3' fill='none' stroke='#c4314b'/>" +
    "<rect x='1' y='7.5' width='10' height='5' rx='1' fill='#c4314b'/></svg>");
  const ICON_UNSAVED = "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>" +
    "<rect x='1' y='1' width='14' height='14' rx='2' fill='#9fe02a' stroke='#3d6b00'/>" +
    "<circle cx='5.5' cy='6' r='1.1'/><circle cx='10.5' cy='6' r='1.1'/>" +
    "<path d='M4.5 9.5q3.5 3.5 7 0' fill='none' stroke='#000' stroke-width='1.2' stroke-linecap='round'/></svg>");
  const favicon = document.head.appendChild(document.createElement("link"));
  favicon.rel = "icon";
  let baseTitle = name;
  let unsaved = false;
  const updateTab = () => {
    document.title = (unsaved ? "*" : "") + baseTitle;
    favicon.href = unsaved ? ICON_UNSAVED : ICON;
  };
  updateTab();

  const frame = document.createElement("iframe");
  frame.src = viewerSrc;
  frame.allow = "fullscreen; clipboard-write";
  frame.addEventListener("load", () => frame.focus());
  document.body.append(frame);

  window.addEventListener("message", (e) => {
    if (e.origin !== viewerOrigin || e.source !== frame.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === "title" && typeof msg.title === "string") {
      baseTitle = msg.title;
      updateTab();
    } else if (msg.type === "dirty") {
      unsaved = !!msg.dirty;
      updateTab();
    } else if (msg.type === "openNative") {
      try { sessionStorage.setItem(BYPASS_KEY, url); } catch {}
      location.reload();
    }
  });
})();
