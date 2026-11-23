// Registers content.js, which swaps Edge's built-in PDF viewer for ours on the
// same URL. The toolbar button turns this on/off by (un)registering the script.

const SCRIPT = {
  id: "pdf-viewer",
  matches: ["<all_urls>"],
  js: ["content.js"],
  runAt: "document_start",
  allFrames: false,
};

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  return enabled;
}

async function sync() {
  const on = await isEnabled();
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT.id] })).length > 0;
  if (on && !registered) await chrome.scripting.registerContentScripts([SCRIPT]);
  if (!on && registered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT.id] });

  chrome.action.setBadgeText({ text: on ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#888" });
  chrome.action.setTitle({
    title: `PDF Citation Hover: ${on ? "ON (click to turn off)" : "OFF (click to turn on)"}`,
  });
}

chrome.action.onClicked.addListener(async () => {
  await chrome.storage.local.set({ enabled: !(await isEnabled()) });
  await sync();
});
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
sync(); // also whenever the service worker starts, in case registration was lost
