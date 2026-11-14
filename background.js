"use strict";

/*
 * FoxLock background script (Firefox MV3 event page).
 *
 * State lives in browser.storage.session so it survives the event page being
 * unloaded and reloaded. All listeners are registered synchronously at the top
 * level, which Firefox requires for event pages to be woken by events.
 */

const LOCK_URL = browser.runtime.getURL("lock.html");
const STATE_KEY = "foxlockState";
const ATTEMPTS_KEY = "attemptsLeft";
const MAX_ATTEMPTS = 3;

// Windows and tabs created by session restore right after startup are hidden
// instead of treated as a bypass attempt, for this long after the lock starts.
const STARTUP_GRACE_MS = 5000;

const DEFAULT_STATE = {
  // True means no lock is active. startLock() flips it to false.
  isUnlocked: true,
  lockTabId: null,
  lockWindowId: null,
  startedAt: 0,
  // windowId -> window state before FoxLock minimized it
  hiddenWindows: {}
};

let state = { ...DEFAULT_STATE };
let starting = false; // in memory only: true while the lock window is being created
let exiting = false;  // in memory only: guards against re-entrant exit
let startPromise = Promise.resolve();

const ready = browser.storage.session
  .get(STATE_KEY)
  .then((stored) => {
    if (stored[STATE_KEY]) {
      state = { ...DEFAULT_STATE, ...stored[STATE_KEY] };
    }
  })
  .catch((err) => console.error("FoxLock: could not load state", err));

function saveState() {
  return browser.storage.session.set({ [STATE_KEY]: state });
}

function isLocked() {
  return !state.isUnlocked;
}

function inStartupGrace() {
  return Date.now() - state.startedAt < STARTUP_GRACE_MS;
}

/* ------------------------------------------------------------------ */
/* Exit: close every window, which quits Firefox on Windows and Linux. */
/* ------------------------------------------------------------------ */

async function exitBrowser() {
  if (exiting) {
    return;
  }
  exiting = true;
  try {
    const windows = await browser.windows.getAll();
    await Promise.allSettled(windows.map((w) => browser.windows.remove(w.id)));
  } catch (err) {
    console.error("FoxLock: exit failed", err);
  } finally {
    exiting = false;
  }
}

/* ------------------------------------------------------------------ */
/* Lock                                                                */
/* ------------------------------------------------------------------ */

async function minimizeWindow(win) {
  if (!win || win.id === state.lockWindowId || win.state === "minimized") {
    return;
  }
  try {
    state.hiddenWindows[win.id] = win.state || "normal";
    await saveState();
    await browser.windows.update(win.id, { state: "minimized" });
  } catch (err) {
    // The window may already be gone.
  }
}

async function hideOtherWindows() {
  const windows = await browser.windows.getAll();
  for (const w of windows) {
    await minimizeWindow(w);
  }
  try {
    await browser.windows.update(state.lockWindowId, { focused: true });
  } catch (err) {
    // Ignore: the focus guard will correct this on the next focus change.
  }
}

async function startLock() {
  await ready;
  exiting = false;
  starting = true;
  try {
    state = { ...DEFAULT_STATE, isUnlocked: false, startedAt: Date.now() };
    await saveState();
    await browser.storage.session.set({ [ATTEMPTS_KEY]: MAX_ATTEMPTS });
    await FoxAuth.ensure(); // creates or upgrades the stored password record

    const win = await browser.windows.create({
      url: LOCK_URL,
      type: "normal",
      state: "maximized",
      focused: true
    });
    const tabs = await browser.tabs.query({ windowId: win.id });
    if (!tabs.length) {
      throw new Error("lock tab not found");
    }
    state.lockWindowId = win.id;
    state.lockTabId = tabs[0].id;
    await saveState();
  } catch (err) {
    // Fail closed: if the lock cannot be shown, do not leave the browser open.
    console.error("FoxLock: could not start lock", err);
    starting = false;
    await exitBrowser();
    return;
  }
  starting = false;
  await hideOtherWindows();
}

/* ------------------------------------------------------------------ */
/* Unlock                                                              */
/* ------------------------------------------------------------------ */

async function unlock() {
  const { lockWindowId, hiddenWindows } = state;

  // Flip the flag first so closing the lock tab is not treated as a bypass.
  state.isUnlocked = true;
  state.lockTabId = null;
  state.lockWindowId = null;
  state.hiddenWindows = {};
  await saveState();
  await browser.storage.session.set({ [ATTEMPTS_KEY]: MAX_ATTEMPTS });

  for (const [id, previous] of Object.entries(hiddenWindows)) {
    try {
      await browser.windows.update(Number(id), { state: previous });
    } catch (err) {
      // Window closed in the meantime.
    }
  }

  const remaining = (await browser.windows.getAll()).filter(
    (w) => w.id !== lockWindowId
  );
  if (remaining.length === 0) {
    // Never close the last window, or the browser would quit.
    await browser.windows.create({});
  } else {
    try {
      await browser.windows.update(remaining[0].id, { focused: true });
    } catch (err) {
      // Ignore.
    }
  }

  try {
    await browser.windows.remove(lockWindowId);
  } catch (err) {
    // Already closed.
  }
}

/* ------------------------------------------------------------------ */
/* Messages from lock.js                                               */
/* ------------------------------------------------------------------ */

async function handleMessage(message, sender) {
  await ready;
  await startPromise;

  if (!message || typeof message.action !== "string") {
    return { ok: false, reason: "bad-message" };
  }
  if (sender.id !== browser.runtime.id) {
    return { ok: false, reason: "untrusted-sender" };
  }
  if (!isLocked()) {
    return { ok: false, reason: "not-locked" };
  }
  if (!sender.tab || sender.tab.id !== state.lockTabId) {
    return { ok: false, reason: "untrusted-sender" };
  }

  switch (message.action) {
    case "unlock": {
      // The background re-checks the password so that a forged "unlock"
      // message from the lock page console alone is not enough.
      if (!(await FoxAuth.verify(message.password))) {
        return { ok: false, reason: "bad-password" };
      }
      // Reply first; unlock() closes the page that is waiting for the reply.
      unlock().catch((err) => console.error("FoxLock: unlock failed", err));
      return { ok: true };
    }
    case "exit":
      await exitBrowser();
      return { ok: true };
    default:
      return { ok: false, reason: "unknown-action" };
  }
}

browser.runtime.onMessage.addListener((message, sender) =>
  handleMessage(message, sender)
);

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

browser.runtime.onStartup.addListener(() => {
  startPromise = startLock();
});

// Lets you test right after installing without restarting the browser.
browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    startPromise = startLock();
  }
});

/* ------------------------------------------------------------------ */
/* Bypass detection                                                    */
/* ------------------------------------------------------------------ */

// The lock tab was closed.
browser.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (isLocked() && tabId === state.lockTabId) {
    await exitBrowser();
  }
});

// The lock window was closed.
browser.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  if (isLocked() && windowId === state.lockWindowId) {
    await exitBrowser();
  }
});

// The lock tab navigated away from lock.html.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }
  await ready;
  if (!isLocked() || starting || tabId !== state.lockTabId) {
    return;
  }
  // about:blank is the transient URL of a tab that is still opening.
  if (changeInfo.url.startsWith(LOCK_URL) || changeInfo.url === "about:blank") {
    return;
  }
  await exitBrowser();
});

// A new tab was opened.
browser.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (!isLocked() || starting || exiting || tab.id === state.lockTabId) {
    return;
  }
  // Tabs restored into other windows right after startup are tolerated.
  if (tab.windowId !== state.lockWindowId && inStartupGrace()) {
    return;
  }
  await exitBrowser();
});

// A new window was opened.
browser.windows.onCreated.addListener(async (win) => {
  await ready;
  if (!isLocked() || starting || exiting || win.id === state.lockWindowId) {
    return;
  }
  if (inStartupGrace()) {
    await minimizeWindow(win);
    return;
  }
  await exitBrowser();
});

// Focus moved to another window: hide it and bring the lock window back.
browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    return;
  }
  await ready;
  if (
    !isLocked() ||
    starting ||
    exiting ||
    state.lockWindowId === null ||
    windowId === state.lockWindowId
  ) {
    return;
  }
  try {
    const other = await browser.windows.get(windowId);
    await minimizeWindow(other);
    await browser.windows.update(state.lockWindowId, { focused: true });
  } catch (err) {
    // Window closed in the meantime.
  }
});
