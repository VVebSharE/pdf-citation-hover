import { CitationResolver } from "./citations.js";

const pdfjsLib = await import("./lib/pdf.min.mjs");
globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads it from the global
const pdfjsViewer = await import("./lib/pdf_viewer.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./lib/pdf.worker.min.mjs", import.meta.url).href;

const { AnnotationEditorType: AET, AnnotationEditorParamsType: AEP, AnnotationMode } = pdfjsLib;
const ScrollMode = { VERTICAL: 0, PAGE: 3 };
const SpreadMode = { NONE: 0, ODD: 1, EVEN: 2 };
const HIGHLIGHT_COLORS = { yellow: "#FFFF98", green: "#53FFBC", blue: "#80EBFF", pink: "#FFCBE6", red: "#FF4F5F" };
const PEN_COLORS = ["#000000", "#e81224", "#f7630c", "#fff100", "#16c60c", "#0078d7", "#886ce4", "#ffffff"];

const $ = (id) => document.getElementById(id);
const container = $("viewerContainer");
const fileUrl = new URLSearchParams(location.search).get("file");
const inFrame = window.parent !== window;

// ---- helpers --------------------------------------------------------------

function showStatus(msg) {
  $("status").textContent = msg;
  $("status").hidden = !msg;
}

function showProgress(text, frac) {
  $("progress").hidden = text == null;
  if (text == null) return;
  $("progressText").textContent = text;
  $("progressBar").style.width = `${Math.round((frac || 0) * 100)}%`;
}

function fileNameOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

function pdfFileName() {
  const n = fileNameOf(fileUrl);
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

function setTitle(t) {
  document.title = t;
  if (inFrame) window.parent.postMessage({ type: "title", title: t }, "*");
}

// Unsaved changes: like Edge, mark the tab ("*" title prefix, changed icon)
// and enable Save on local files only when there's something to save.
function setDirty(on) {
  dirty = on;
  $("btnSave").disabled = !on && fileUrl.startsWith("file:");
  if (inFrame) window.parent.postMessage({ type: "dirty", dirty: on }, "*");
}

function loadBytes(url) {
  if (url.startsWith("file:")) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "arraybuffer";
      xhr.onload = () =>
        xhr.response && (xhr.status === 0 || xhr.status === 200)
          ? resolve(new Uint8Array(xhr.response))
          : reject(new Error("file-access"));
      xhr.onerror = () => reject(new Error("file-access"));
      xhr.send();
    });
  }
  return fetch(url, { credentials: "include" }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  });
}

// ---- viewer setup ------------------------------------------------------------

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container,
  eventBus,
  linkService,
  findController,
  imageResourcesPath: "./lib/images/",
  annotationEditorMode: AET.NONE,
  annotationEditorHighlightColors: Object.entries(HIGHLIGHT_COLORS).map(([k, v]) => `${k}=${v}`).join(","),
  enableHighlightFloatingButton: true,
});
linkService.setViewer(pdfViewer);

let pdfDocument = null;
let resolver = null;
let fileSize = 0;
let dirty = false;

async function main() {
  if (!fileUrl) return showStatus("No PDF specified.");
  setTitle(fileNameOf(fileUrl));
  showStatus("Loading…");

  let data;
  try {
    data = await loadBytes(fileUrl);
  } catch (e) {
    return showStatus(
      e.message === "file-access"
        ? "Can't read this local file.\n\nOpen edge://extensions, click \"Details\" on PDF Citation Hover, " +
          "and turn on \"Allow access to file URLs\". Then reload this tab."
        : `Couldn't load the PDF: ${e.message}\n\nUse Settings (gear icon) → "Open in Edge's built-in viewer" to open it normally.`
    );
  }
  fileSize = data.length;

  try {
    pdfDocument = await pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      cMapUrl: new URL("./lib/cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./lib/standard_fonts/", import.meta.url).href,
    }).promise;
  } catch (e) {
    return showStatus(`Couldn't open the PDF: ${e.message}`);
  }
  showStatus("");

  resolver = new CitationResolver(pdfDocument);
  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);
  $("pageOf").textContent = `of ${pdfDocument.numPages}`;

  pdfDocument.annotationStorage.onSetModified = () => setDirty(true);
  pdfDocument.annotationStorage.onResetModified = () => setDirty(false);
  setDirty(false);

  pdfDocument.getMetadata().then(({ info }) => {
    const t = info?.Title?.trim();
    if (t && t.length > 3 && !/^(untitled|microsoft word)/i.test(t)) setTitle(t);
  }).catch(() => {});

  initSidebar();
}

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "auto";
  const hash = fileUrl.includes("#") ? fileUrl.slice(fileUrl.indexOf("#") + 1) : "";
  if (hash) linkService.setHash(hash);
  updatePageViewMenu();
});
eventBus.on("pagechanging", ({ pageNumber }) => {
  $("pageNum").value = pageNumber;
  markCurrentThumb(pageNumber);
  markCurrentOutline(pageNumber);
});

// Like Edge: show the zoom level briefly when it changes.
let zoomToastTimer = 0;
let lastScale = null;
eventBus.on("scalechanging", ({ scale, presetValue }) => {
  const fitWidth = presetValue === "page-width";
  $("btnFit").title = fitWidth ? "Fit to page (Ctrl+\\)" : "Fit to width (Ctrl+\\)";
  $("btnFit").querySelector("use").setAttribute("href", `icons.svg#i-${fitWidth ? "fitpage" : "fitwidth"}`);
  if (lastScale !== null && Math.abs(scale - lastScale) > 0.001) {
    $("zoomToast").textContent = `${Math.round(scale * 100)}%`;
    $("zoomToast").hidden = false;
    clearTimeout(zoomToastTimer);
    zoomToastTimer = setTimeout(() => ($("zoomToast").hidden = true), 1200);
  }
  lastScale = scale;
});

let toastTimer = 0;
function toast(msg, ms = 3500) {
  $("toast").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), ms);
}

// Keep "fit" zoom levels fitted when the available space changes.
new ResizeObserver(() => {
  const v = pdfViewer.currentScaleValue;
  if (pdfDocument && typeof v === "string" && isNaN(Number(v))) pdfViewer.currentScaleValue = v;
}).observe(container);

// ---- page navigation / zoom / rotate --------------------------------------------

$("pageNum").addEventListener("change", (e) => {
  const n = Math.max(1, Math.min(pdfViewer.pagesCount, parseInt(e.target.value, 10) || 1));
  pdfViewer.currentPageNumber = n;
  e.target.value = n;
});
$("pageNum").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});
$("pageNum").addEventListener("focus", (e) => e.target.select());

function zoom(factor) {
  const s = Math.min(10, Math.max(0.1, pdfViewer.currentScale * factor));
  pdfViewer.currentScale = Math.round(s * 100) / 100;
}
$("zoomIn").onclick = () => zoom(1.1);
$("zoomOut").onclick = () => zoom(1 / 1.1);
$("settingsMenu").addEventListener("click", (e) => {
  const v = e.target.closest("[data-zoom]")?.dataset.zoom;
  if (!v) return;
  pdfViewer.currentScaleValue = v;
  closeMenus();
});
container.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

function toggleFit() {
  pdfViewer.currentScaleValue = pdfViewer.currentScaleValue === "page-width" ? "page-fit" : "page-width";
}

// ---- pin toolbar --------------------------------------------------------------------------
// Pinned (default): toolbar always visible. Unpinned (like Edge): it hides as
// soon as the mouse leaves it, and slides back when the mouse moves to the top
// of the window. It stays while a menu or the find bar is open.

let pinned = true;
try {
  pinned = localStorage.getItem("toolbarPinned") !== "false";
} catch {}
let tbHideTimer = 0;

function toolbarBusy() {
  return (
    !!document.querySelector(".menu:not([hidden])") ||
    !$("findbar").hidden ||
    $("toolbar").matches(":hover") ||
    document.activeElement === $("pageNum")
  );
}

function scheduleToolbarHide(ms = 500) {
  clearTimeout(tbHideTimer);
  if (pinned) return;
  tbHideTimer = setTimeout(() => {
    if (pinned) return;
    if (toolbarBusy()) scheduleToolbarHide(ms); // try again once you're done with it
    else document.body.classList.add("tb-hidden");
  }, ms);
}

function showToolbar() {
  clearTimeout(tbHideTimer);
  document.body.classList.remove("tb-hidden");
}

function applyPin() {
  document.body.classList.toggle("tb-unpinned", !pinned);
  $("btnPin").setAttribute("aria-pressed", pinned);
  $("btnPin").title = pinned ? "Unpin toolbar" : "Pin toolbar";
  $("btnPin").querySelector("use").setAttribute("href", `icons.svg#i-${pinned ? "pin-filled" : "pin"}`);
  if (pinned) showToolbar();
  else scheduleToolbarHide(300);
}
$("btnPin").onclick = () => {
  pinned = !pinned;
  try {
    localStorage.setItem("toolbarPinned", String(pinned));
  } catch {}
  // The pages area grows/shrinks by the toolbar's height; scroll by the same
  // amount so the PDF stays where it is on screen.
  const before = container.scrollTop;
  const bar = $("toolbar").offsetHeight;
  applyPin();
  container.scrollTop = Math.max(0, before + (pinned ? bar : -bar));
};
applyPin();

document.addEventListener("mousemove", (e) => {
  if (pinned) return;
  if (e.clientY < 48) showToolbar();
  else if (!document.body.classList.contains("tb-hidden")) scheduleToolbarHide();
});
$("toolbar").addEventListener("mouseleave", () => scheduleToolbarHide());
container.addEventListener("scroll", () => {
  if (!pinned && !document.body.classList.contains("tb-hidden")) scheduleToolbarHide(300);
}, { passive: true });

// ---- full screen ------------------------------------------------------------------------

$("btnFullscreen").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => toast("Full screen isn't available here. Press F11 instead."));
};
document.addEventListener("fullscreenchange", () => {
  const on = !!document.fullscreenElement;
  $("btnFullscreen").title = on ? "Exit full screen" : "Full screen";
  $("btnFullscreen").querySelector("use").setAttribute("href", `icons.svg#i-${on ? "fullscreen-exit" : "fullscreen"}`);
});
$("btnFit").onclick = toggleFit;

function rotate(delta) {
  pdfViewer.pagesRotation = (pdfViewer.pagesRotation + delta + 360) % 360;
  resetThumbs();
}
$("btnRotate").onclick = () => rotate(90);

// ---- page view (one / two pages) ---------------------------------------------------

function updatePageViewMenu() {
  const spread = pdfViewer.spreadMode;
  $("pageViewMenu").querySelector('[data-spread="single"]').setAttribute("aria-checked", spread === SpreadMode.NONE);
  $("pageViewMenu").querySelector('[data-spread="double"]').setAttribute("aria-checked", spread !== SpreadMode.NONE);
  $("optCover").setAttribute("aria-checked", spread === SpreadMode.EVEN);
  $("optCover").disabled = spread === SpreadMode.NONE;
  $("optContinuous").setAttribute("aria-checked", pdfViewer.scrollMode !== ScrollMode.PAGE);
}
$("pageViewMenu").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const cover = $("optCover").getAttribute("aria-checked") === "true";
  if (b.dataset.spread === "single") pdfViewer.spreadMode = SpreadMode.NONE;
  else if (b.dataset.spread === "double") pdfViewer.spreadMode = cover ? SpreadMode.EVEN : SpreadMode.ODD;
  else if (b === $("optCover") && pdfViewer.spreadMode !== SpreadMode.NONE)
    pdfViewer.spreadMode = pdfViewer.spreadMode === SpreadMode.EVEN ? SpreadMode.ODD : SpreadMode.EVEN;
  else if (b === $("optContinuous"))
    pdfViewer.scrollMode = pdfViewer.scrollMode === ScrollMode.PAGE ? ScrollMode.VERTICAL : ScrollMode.PAGE;
  const v = pdfViewer.currentScaleValue;
  if (typeof v === "string" && isNaN(Number(v))) pdfViewer.currentScaleValue = v;
  updatePageViewMenu();
});

// ---- menus ---------------------------------------------------------------------------

function closeMenus() {
  for (const m of document.querySelectorAll(".menu")) m.hidden = true;
  for (const b of document.querySelectorAll("[data-menu].open")) b.classList.remove("open");
}
document.addEventListener("click", (e) => {
  const opener = e.target.closest("[data-menu]");
  if (opener) {
    const menu = $(opener.dataset.menu);
    const wasOpen = !menu.hidden;
    closeMenus();
    if (wasOpen) return;
    if (opener.dataset.menu === "pageViewMenu") updatePageViewMenu();
    menu.hidden = false;
    opener.classList.add("open");
    const r = (opener.closest(".split") || opener).getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(4, Math.min(r.left, document.documentElement.clientWidth - w - 4))}px`;
    return;
  }
  if (!e.target.closest(".menu")) closeMenus();
});

// ---- annotation tools ---------------------------------------------------------------

let currentTool = null;
const TOOL_MODES = { text: AET.FREETEXT, draw: AET.INK, highlight: AET.HIGHLIGHT, erase: AET.INK };

function setTool(tool) {
  if (!pdfDocument) return;
  // Move focus out of the page first: pdf.js finishes an in-progress drawing
  // when its layer loses focus, and it must happen before the mode changes.
  const btn = document.querySelector(`[data-tool="${tool || currentTool}"]`) || $("btnSidebar");
  btn.focus({ preventScroll: true });
  currentTool = tool;
  try {
    pdfViewer.annotationEditorMode = { mode: tool ? TOOL_MODES[tool] : AET.NONE };
  } catch (e) {
    console.warn("Editor mode unavailable:", e);
  }
  container.classList.toggle("erasing", tool === "erase");
  for (const b of document.querySelectorAll("[data-tool]")) {
    b.setAttribute("aria-pressed", b.dataset.tool === tool);
  }
  if (tool) hidePop();
}
function textSelectionInPdf() {
  const sel = document.getSelection();
  const node = sel && !sel.isCollapsed ? sel.anchorNode : null;
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return !!el?.closest?.(".textLayer");
}

// Highlight the selected text right away (one-shot, like Edge's selection
// menu). pdf.js's own route for this switches into highlight mode and creates
// the highlight on the mode-change event, but from the second time on that
// event fires before the mode has actually switched, so nothing is created.
// Instead: switch, wait until the switch has settled, then highlight.
let highlightingSelection = false;
async function highlightSelectionNow() {
  if (highlightingSelection || !textSelectionInPdf()) return;
  highlightingSelection = true;
  const sel = document.getSelection();
  const ranges = [];
  for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
  const previous = currentTool;
  try {
    if (currentTool !== "highlight") {
      setTool("highlight");
      await new Promise((r) => setTimeout(r, 60));
      if (sel.isCollapsed) {
        sel.removeAllRanges();
        for (const r of ranges) sel.addRange(r);
      }
    }
    eventBus.dispatch("editingaction", { source: window, name: "highlightSelection" });
    if (previous !== "highlight") {
      await new Promise((r) => setTimeout(r, 0));
      setTool(previous);
    }
  } finally {
    highlightingSelection = false;
  }
}

for (const b of document.querySelectorAll("[data-tool]")) {
  b.addEventListener("click", () => {
    // Like Edge: with text selected, Highlight highlights the selection right away.
    if (b.dataset.tool === "highlight" && currentTool !== "highlight" && textSelectionInPdf()) {
      highlightSelectionNow();
      return;
    }
    setTool(currentTool === b.dataset.tool ? null : b.dataset.tool);
  });
}

// pdf.js's floating "Highlight" button (shown after selecting text): use our route.
document.addEventListener("click", (e) => {
  if (!e.target.closest?.(".highlightButton")) return;
  e.stopPropagation();
  e.preventDefault();
  highlightSelectionNow();
}, true);

// Keep the toolbar in sync if pdf.js switches tools itself (e.g. double-clicking an annotation).
const MODE_TOOLS = { [AET.NONE]: null, [AET.FREETEXT]: "text", [AET.INK]: "draw", [AET.HIGHLIGHT]: "highlight" };
eventBus.on("showannotationeditorui", ({ mode }) => {
  const tool = MODE_TOOLS[mode];
  if (tool !== undefined && tool !== currentTool) setTool(tool);
});

function setParam(type, value) {
  eventBus.dispatch("switchannotationeditorparams", { source: window, type, value });
}

// Defaults like Edge (pdf.js would otherwise use the theme's text color, e.g. white in dark mode).
eventBus.on("annotationeditoruimanager", () => {
  setParam(AEP.INK_COLOR, "#000000");
  setParam(AEP.INK_THICKNESS, 2);
  setParam(AEP.FREETEXT_COLOR, "#000000");
  setParam(AEP.FREETEXT_SIZE, 14);
});

function buildSwatches(el, colors, onPick, initial) {
  for (const c of colors) {
    const b = document.createElement("button");
    b.style.background = c;
    b.title = c;
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", c === initial);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const s of el.children) s.setAttribute("aria-checked", s === b);
      onPick(c);
    });
    el.append(b);
  }
}
buildSwatches(document.querySelector('[data-param="ink-color"]'), PEN_COLORS, (c) => {
  setParam(AEP.INK_COLOR, c);
  if (currentTool !== "draw") setTool("draw");
}, "#000000");
buildSwatches(document.querySelector('[data-param="text-color"]'), PEN_COLORS.slice(0, 7), (c) => {
  setParam(AEP.FREETEXT_COLOR, c);
  if (currentTool !== "text") setTool("text");
}, "#000000");
buildSwatches(document.querySelector('[data-param="hl-color"]'), Object.values(HIGHLIGHT_COLORS), (c) => {
  setParam(AEP.HIGHLIGHT_DEFAULT_COLOR, c);
  if (currentTool !== "highlight") setTool("highlight");
}, HIGHLIGHT_COLORS.yellow);

for (const [id, type] of [["inkThickness", AEP.INK_THICKNESS], ["textSize", AEP.FREETEXT_SIZE]]) {
  $(id).addEventListener("input", (e) => {
    $(`${id}Val`).textContent = e.target.value;
    setParam(type, Number(e.target.value));
  });
}
for (const m of ["textMenu", "drawMenu", "hlMenu"]) {
  $(m).addEventListener("click", (e) => e.stopPropagation());
}

// Erase: clicking a drawing, highlight or text box removes it.
function editorAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const ed = el.closest(".annotationEditorLayer > [id]");
    if (ed) return ed;
  }
  return null;
}
container.addEventListener("pointerdown", (e) => {
  if (currentTool !== "erase" || !e.isTrusted) return; // ignore our own synthetic event below
  e.preventDefault();
  e.stopPropagation();
  const ed = editorAt(e.clientX, e.clientY);
  if (!ed) return;
  // Select it the way pdf.js expects, then delete the selection.
  ed.focus();
  ed.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: e.clientX, clientY: e.clientY, button: 0, isPrimary: true }));
  setTimeout(() => {
    eventBus.dispatch("editingaction", { source: window, name: "delete" });
  }, 0);
}, true);

// ---- find -----------------------------------------------------------------------------

function openFind() {
  $("findbar").hidden = false;
  $("findInput").focus();
  $("findInput").select();
  if ($("findInput").value) runFind("");
}
function closeFind() {
  $("findbar").hidden = true;
  eventBus.dispatch("findbarclose", { source: window });
  container.focus();
}
function runFind(type, findPrevious = false) {
  eventBus.dispatch("find", {
    source: window,
    type,
    query: $("findInput").value,
    caseSensitive: $("findCase").getAttribute("aria-pressed") === "true",
    entireWord: $("findWord").getAttribute("aria-pressed") === "true",
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}
$("btnFind").onclick = () => ($("findbar").hidden ? openFind() : closeFind());
$("findClose").onclick = closeFind;
$("findNext").onclick = () => runFind("again", false);
$("findPrev").onclick = () => runFind("again", true);
$("findInput").addEventListener("input", () => runFind(""));
$("findInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runFind("again", e.shiftKey);
  else if (e.key === "Escape") closeFind();
});
for (const id of ["findCase", "findWord"]) {
  $(id).onclick = () => {
    const b = $(id);
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true");
    runFind("");
  };
}
function showFindCount({ current, total }) {
  $("findCount").textContent = total ? `${current} of ${total}` : $("findInput").value ? "0 results" : "";
}
eventBus.on("updatefindmatchescount", ({ matchesCount }) => showFindCount(matchesCount));
eventBus.on("updatefindcontrolstate", ({ state, matchesCount }) => {
  $("findInput").classList.toggle("notfound", state === 1 && !!$("findInput").value);
  if (state !== 3) showFindCount(matchesCount);
});

// ---- sidebar: thumbnails & contents ---------------------------------------------------

let thumbObserver = null;
let thumbsBuilt = false;
let hasOutline = false;

function toggleSidebar(force) {
  const open = force ?? !sidebarOpen();
  // The sidebar slides in over the pages, so the PDF doesn't move or re-zoom.
  document.body.classList.toggle("sidebar-open", open);
  $("sidebar").setAttribute("aria-hidden", !open);
  $("btnSidebar").setAttribute("aria-pressed", open);
  if (open && !$("thumbs").hidden) buildThumbs();
}
const sidebarOpen = () => document.body.classList.contains("sidebar-open");
$("btnSidebar").onclick = () => toggleSidebar();
$("sbClose").onclick = () => toggleSidebar(false);

function selectTab(which) {
  const thumbs = which === "thumbs";
  $("thumbs").hidden = !thumbs;
  $("outline").hidden = thumbs;
  $("tabThumbs").setAttribute("aria-selected", thumbs);
  $("tabOutline").setAttribute("aria-selected", !thumbs);
  $("sbTitle").textContent = thumbs ? "Page Thumbnails" : "Table of Contents";
  if (thumbs) buildThumbs();
}
$("tabThumbs").onclick = () => selectTab("thumbs");
$("tabOutline").onclick = () => selectTab("outline");

async function initSidebar() {
  const outline = await pdfDocument.getOutline().catch(() => null);
  hasOutline = !!outline?.length;
  const root = $("outline");
  root.replaceChildren();
  outlineEntries = [];
  if (!hasOutline) {
    root.innerHTML = '<div class="empty">This document has no table of contents.</div>';
  } else {
    root.append(renderOutline(outline));
    resolveOutlinePages();
  }
  selectTab(hasOutline ? "outline" : "thumbs");
}

// Outline entries in document order, with their page numbers, to highlight
// the section you're reading (like Edge).
let outlineEntries = [];

async function resolveOutlinePages() {
  for (const entry of outlineEntries) {
    try {
      let dest = entry.dest;
      if (typeof dest === "string") dest = await pdfDocument.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const ref = dest[0];
      entry.page = Number.isInteger(ref) ? ref + 1 : (await pdfDocument.getPageIndex(ref)) + 1;
    } catch {}
  }
  markCurrentOutline(pdfViewer.currentPageNumber);
}

function markCurrentOutline(pageNumber) {
  let current = null;
  for (const e of outlineEntries) {
    if (e.page != null && e.page <= pageNumber) current = e;
  }
  for (const li of $("outline").querySelectorAll("li.current")) li.classList.remove("current");
  if (!current) return;
  // Show the deepest entry that's visible (its collapsed parent otherwise).
  let li = current.li;
  for (let p = li.parentElement.closest("li"); p; p = p.parentElement.closest("li")) {
    if (!p.classList.contains("open")) li = p;
  }
  li.classList.add("current");
  if (sidebarOpen() && !$("outline").hidden) li.firstChild.scrollIntoView({ block: "nearest" });
}

function renderOutline(items) {
  const ul = document.createElement("ul");
  for (const item of items) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    row.tabIndex = 0;
    const tw = document.createElement("button");
    tw.className = "tw";
    tw.tabIndex = -1;
    if (item.items?.length) {
      tw.innerHTML = '<svg><use href="icons.svg#i-caret"/></svg>';
      tw.onclick = (e) => {
        e.stopPropagation();
        li.classList.toggle("open");
        markCurrentOutline(pdfViewer.currentPageNumber);
      };
    } else {
      tw.style.visibility = "hidden";
    }
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = item.title;
    if (item.bold) label.style.fontWeight = "600";
    if (item.italic) label.style.fontStyle = "italic";
    const go = () => {
      if (item.dest) linkService.goToDestination(item.dest);
      else if (item.url) window.open(item.url, "_blank", "noopener");
    };
    row.onclick = go;
    row.onkeydown = (e) => {
      if (e.key === "Enter") go();
    };
    row.append(tw, label);
    li.append(row);
    if (item.dest) outlineEntries.push({ dest: item.dest, li, page: null });
    if (item.items?.length) {
      li.append(renderOutline(item.items));
      if (item.count > 0) li.classList.add("open");
    }
    ul.append(li);
  }
  return ul;
}

async function buildThumbs() {
  if (thumbsBuilt || !pdfDocument) return;
  thumbsBuilt = true;
  const list = $("thumbs");
  list.replaceChildren();
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      renderThumb(e.target);
    }
  }, { root: list, rootMargin: "300px" });

  const first = await pdfDocument.getPage(1);
  const vp = first.getViewport({ scale: 1, rotation: (first.rotate + pdfViewer.pagesRotation) % 360 });
  const ratio = vp.height / vp.width;
  for (let i = 1; i <= pdfDocument.numPages; i++) {
    const item = document.createElement("div");
    item.className = "thumb";
    item.dataset.page = i;
    item.innerHTML = `<div class="ti" style="height:${Math.round(150 * ratio)}px"></div><span>${i}</span>`;
    item.onclick = () => (pdfViewer.currentPageNumber = i);
    list.append(item);
    thumbObserver.observe(item);
  }
  markCurrentThumb(pdfViewer.currentPageNumber);
}

async function renderThumb(item) {
  const page = await pdfDocument.getPage(Number(item.dataset.page));
  const rotation = (page.rotate + pdfViewer.pagesRotation) % 360;
  const base = page.getViewport({ scale: 1, rotation });
  const vp = page.getViewport({ scale: (150 * 2) / base.width, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  const ti = item.querySelector(".ti");
  ti.style.height = "";
  ti.replaceChildren(canvas);
}

function resetThumbs() {
  thumbsBuilt = false;
  if (sidebarOpen() && !$("thumbs").hidden) buildThumbs();
}

function markCurrentThumb(n) {
  for (const t of $("thumbs").querySelectorAll(".thumb.current")) t.classList.remove("current");
  const t = $("thumbs").querySelector(`.thumb[data-page="${n}"]`);
  if (!t) return;
  t.classList.add("current");
  if (sidebarOpen()) t.scrollIntoView({ block: "nearest" });
}

// ---- read aloud ---------------------------------------------------------------------------

let reading = false;

function setReading(on) {
  reading = on;
  const b = $("btnRead");
  b.setAttribute("aria-pressed", on);
  b.querySelector("use").setAttribute("href", `icons.svg#i-${on ? "stop" : "read"}`);
  b.title = on ? "Stop reading" : "Read aloud (Ctrl+Shift+U)";
}

function speak(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const lang = navigator.language || "en-US";
    u.voice =
      voices.find((v) => v.lang === lang && /natural/i.test(v.name)) ||
      voices.find((v) => v.lang === lang) ||
      null;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function readAloud() {
  if (reading) {
    setReading(false);
    speechSynthesis.cancel();
    return;
  }
  if (!pdfDocument) return;
  setReading(true);
  for (let p = pdfViewer.currentPageNumber; p <= pdfDocument.numPages && reading; p++) {
    if (pdfViewer.currentPageNumber !== p) pdfViewer.currentPageNumber = p;
    const tc = await (await pdfDocument.getPage(p)).getTextContent();
    let text = "";
    for (const it of tc.items) {
      if (typeof it.str !== "string") continue;
      text += it.str;
      if (it.hasEOL) text = /-$/.test(text) ? text.slice(0, -1) : `${text} `;
    }
    // Short chunks: long utterances get cut off by some voices.
    const chunks = text.replace(/\s+/g, " ").match(/[^.!?]{1,250}([.!?]+|$)\s*/g) || [];
    for (const c of chunks) {
      if (!reading) break;
      if (c.trim()) await speak(c.trim());
    }
  }
  setReading(false);
}
$("btnRead").onclick = readAloud;
window.addEventListener("pagehide", () => speechSynthesis.cancel());

// ---- print -----------------------------------------------------------------------------------

let printing = false;

async function printDoc() {
  if (!pdfDocument || printing) return;
  printing = true;
  closeMenus();
  const pc = $("printContainer");
  const urls = [];
  try {
    pc.replaceChildren();
    const n = pdfDocument.numPages;
    const printStorage = pdfDocument.annotationStorage.print;
    let pageSize = null;
    for (let i = 1; i <= n && printing; i++) {
      showProgress(`Preparing to print… page ${i} of ${n}`, (i - 1) / n);
      const page = await pdfDocument.getPage(i);
      const rotation = (page.rotate + pdfViewer.pagesRotation) % 360;
      const vp1 = page.getViewport({ scale: 1, rotation });
      pageSize ||= vp1;
      const vp = page.getViewport({ scale: 150 / 72, rotation });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: ctx,
        viewport: vp,
        intent: "print",
        annotationMode: AnnotationMode.ENABLE_STORAGE,
        printAnnotationStorage: printStorage,
      }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r));
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = new Image();
      img.src = url;
      const wrap = document.createElement("div");
      wrap.className = "printPage";
      wrap.append(img);
      pc.append(wrap);
    }
    $("printPageStyle").textContent =
      `@page { size: ${pageSize.width}pt ${pageSize.height}pt; margin: 0; }`;
    await Promise.all([...pc.querySelectorAll("img")].map((i) => i.decode().catch(() => {})));
    showProgress(null);
    window.print();
  } catch (e) {
    showProgress(null);
    showStatus(`Printing failed: ${e.message}`);
    setTimeout(() => showStatus(""), 4000);
  } finally {
    pc.replaceChildren();
    $("printPageStyle").textContent = "";
    for (const u of urls) URL.revokeObjectURL(u);
    printing = false;
  }
}
$("btnPrint").onclick = printDoc;

// ---- save --------------------------------------------------------------------------------------

// Browsers can't write files directly, so saving goes through a small helper
// program (save-helper/, installed once) via native messaging:
//  - Save on a local PDF overwrites the original file.
//  - Save as (and Save on a web PDF) shows a Windows "Save as" dialog.
// Without the helper, a copy is downloaded instead.
const SAVE_HOST = "com.pdfcitationhover.save";
const isLocalFile = !!fileUrl && fileUrl.startsWith("file:");
let savePath = isLocalFile ? fileUrlToPath(fileUrl) : null; // where "Save" writes
let saving = false;

function fileUrlToPath(u) {
  const url = new URL(u);
  const p = decodeURIComponent(url.pathname);
  if (url.host) return `\\\\${url.host}${p.replace(/\//g, "\\")}`; // UNC share
  return p.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
}

function* base64Chunks(bytes, size = 3 * 1024 * 1024) {
  for (let i = 0; i < bytes.length; i += size) {
    const sub = bytes.subarray(i, i + size);
    let s = "";
    for (let j = 0; j < sub.length; j += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(j, j + 0x8000));
    yield btoa(s);
  }
}

function nativeSave(bytes, { path, saveAs }) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(SAVE_HOST);
    } catch (e) {
      return resolve({ ok: false, missing: true, error: e.message });
    }
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
      try { port.disconnect(); } catch {}
    };
    port.onMessage.addListener(finish);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || "The save helper stopped unexpectedly.";
      finish({ ok: false, missing: /not found|forbidden/i.test(err), error: err });
    });
    port.postMessage({ cmd: "begin", path, saveAs, suggestedName: pdfFileName() });
    for (const data of base64Chunks(bytes)) port.postMessage({ cmd: "chunk", data });
    port.postMessage({ cmd: "end" });
  });
}

async function currentBytes() {
  return pdfDocument.annotationStorage.size > 0 ? pdfDocument.saveDocument() : pdfDocument.getData();
}

function downloadBytes(bytes, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function save(saveAs) {
  if (!pdfDocument || saving) return;
  if (!saveAs && isLocalFile && !dirty) return; // nothing to save (Save is greyed out)
  closeMenus();
  saving = true;
  try {
    const bytes = await currentBytes();
    const dialog = saveAs || !savePath;
    if (globalThis.chrome?.runtime?.connectNative) {
      if (!dialog) toast("Saving…", 60000);
      const r = await nativeSave(bytes, { path: savePath, saveAs: dialog });
      if (r.cancelled) {
        $("toast").hidden = true;
        return;
      }
      if (r.ok) {
        savePath = r.path;
        pdfDocument.annotationStorage.resetModified();
        setDirty(false);
        toast(`Saved to ${r.path}`);
        return;
      }
      if (!r.missing) {
        toast(`Couldn't save: ${r.error}`, 6000);
        return;
      }
    }
    // No helper installed: download a copy instead.
    downloadBytes(bytes, pdfFileName());
    pdfDocument.annotationStorage.resetModified();
    setDirty(false);
    toast(
      isLocalFile
        ? "Saved a copy to Downloads. To save over the original file, run save-helper\\install.ps1 once (see README)."
        : "Saved to Downloads.",
      isLocalFile ? 7000 : 3000
    );
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, 6000);
  } finally {
    saving = false;
  }
}
$("btnSave").onclick = () => save(false);
$("mSaveAs").onclick = () => save(true);
$("btnSaveAs").onclick = () => save(true);

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---- more menu ----------------------------------------------------------------------------------

$("mOpenNative").onclick = () => {
  closeMenus();
  if (!inFrame) return;
  setDirty(false);
  window.parent.postMessage({ type: "openNative" }, "*");
};
$("mDownload").onclick = async () => {
  closeMenus();
  if (pdfDocument) downloadBytes(await pdfDocument.getData(), pdfFileName());
};

function formatPdfDate(s) {
  const d = s && pdfjsLib.PDFDateString.toDateObject(s);
  return d ? d.toLocaleString() : "";
}

$("mProps").onclick = async () => {
  closeMenus();
  if (!pdfDocument) return;
  const { info } = await pdfDocument.getMetadata();
  const page = await pdfDocument.getPage(pdfViewer.currentPageNumber);
  const [, , w, h] = page.view;
  const inch = (v) => (v / 72).toFixed(2);
  const rows = [
    ["File", fileNameOf(fileUrl)],
    ["Location", decodeURIComponent(fileUrl.split("#")[0])],
    ["File size", `${(fileSize / 1024 / 1024).toFixed(2)} MB (${fileSize.toLocaleString()} bytes)`],
    ["Title", info?.Title],
    ["Author", info?.Author],
    ["Subject", info?.Subject],
    ["Keywords", info?.Keywords],
    ["Created", formatPdfDate(info?.CreationDate)],
    ["Modified", formatPdfDate(info?.ModDate)],
    ["Application", info?.Creator],
    ["PDF producer", info?.Producer],
    ["PDF version", info?.PDFFormatVersion],
    ["Pages", String(pdfDocument.numPages)],
    ["Page size", `${inch(w)} × ${inch(h)} in (${(w / 72 * 25.4).toFixed(0)} × ${(h / 72 * 25.4).toFixed(0)} mm)`],
  ];
  const table = $("propsTable");
  table.replaceChildren();
  for (const [k, v] of rows) {
    if (!v) continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  $("propsDlg").showModal();
};

// ---- keyboard shortcuts -------------------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = e.target.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "f") openFind();
    else if (k === "p") printDoc();
    else if (k === "s") save(e.shiftKey);
    else if (k === "u" && e.shiftKey) readAloud();
    else if (k === "=" || k === "+") zoom(1.1);
    else if (k === "-") zoom(1 / 1.1);
    else if (k === "0") pdfViewer.currentScaleValue = "auto";
    else if (k === "]") rotate(90);
    else if (k === "[") rotate(-90);
    else if (k === "\\") toggleFit();
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === "F3") {
    e.preventDefault();
    if ($("findbar").hidden) openFind();
    else runFind("again", e.shiftKey);
    return;
  }
  if (e.key === "Escape") {
    closeMenus();
    if (!$("findbar").hidden) closeFind();
    else if (currentTool) setTool(null);
    hidePop();
    return;
  }
  if (typing || !pdfDocument) return;
  if (e.key === "Home") pdfViewer.currentPageNumber = 1;
  else if (e.key === "End") pdfViewer.currentPageNumber = pdfDocument.numPages;
  else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && pdfViewer.scrollMode === ScrollMode.PAGE) {
    if (e.key === "ArrowRight") pdfViewer.nextPage();
    else pdfViewer.previousPage();
  } else return;
  e.preventDefault();
});

// ---- citation hover card -------------------------------------------------------------------------

const pop = $("citePop");
let activeLink = null;
let showTimer = 0;
let hideTimer = 0;
let token = 0;

function hidePop() {
  clearTimeout(showTimer);
  pop.hidden = true;
  activeLink = null;
  token++;
}

let mouseY = 0;
container.addEventListener("mousemove", (e) => (mouseY = e.clientY), { passive: true });

function placePop(rect) {
  pop.style.left = "0px";
  pop.style.top = "0px";
  pop.hidden = false;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const left = Math.min(Math.max(8, rect.left), vw - w - 8);
  // Prefer above the citation: the mouse pointer hangs down from its tip, so a
  // card placed just below would sit under the pointer.
  const minTop = document.body.classList.contains("tb-hidden") ? 8 : 48;
  let top = rect.top - h - 8;
  if (top < minTop) {
    // No room above: go below, clear of the pointer (about 24px tall).
    top = Math.max(rect.bottom + 6, mouseY + 26);
    if (top + h > vh - 8) top = Math.max(minTop, vh - 8 - h);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

async function showFor(link) {
  const section = link.closest("[data-annotation-id]");
  const page = link.closest(".page");
  if (!section || !page || !resolver) return;
  const my = ++token;
  const result = await resolver.resolveAnnotation(
    Number(page.dataset.pageNumber),
    section.getAttribute("data-annotation-id")
  );
  if (my !== token || activeLink !== link || !result) return;

  const title = $("citeTitle");
  title.textContent = result.title || "";
  title.href = result.title
    ? `https://scholar.google.com/scholar?q=${encodeURIComponent(result.title)}`
    : "about:blank";
  $("citeText").textContent = result.text;
  placePop(section.getBoundingClientRect());
}

container.addEventListener("mouseover", (e) => {
  if (currentTool) return;
  const link = e.target.closest?.(".annotationLayer .linkAnnotation");
  if (!link) return;
  clearTimeout(hideTimer);
  if (link === activeLink) return;
  hidePop();
  activeLink = link;
  showTimer = setTimeout(() => showFor(link), 150);
});
container.addEventListener("mouseout", (e) => {
  const link = e.target.closest?.(".annotationLayer .linkAnnotation");
  if (!link || link.contains(e.relatedTarget)) return;
  clearTimeout(showTimer);
  hideTimer = setTimeout(hidePop, 250);
});
pop.addEventListener("mouseenter", () => clearTimeout(hideTimer));
pop.addEventListener("mouseleave", () => (hideTimer = setTimeout(hidePop, 250)));
container.addEventListener("scroll", hidePop, { passive: true });

main();
