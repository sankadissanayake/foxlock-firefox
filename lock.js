"use strict";

(() => {
  const MAX_ATTEMPTS = 3;
  const DEFAULT_PASSWORD = "admin123";
  const PASSWORD_KEY = "password";
  const ATTEMPTS_KEY = "attemptsLeft";

  const form = document.getElementById("lock-form");
  const input = document.getElementById("password");
  const button = document.getElementById("unlock-btn");
  const errorBox = document.getElementById("error");

  let busy = false;

  function showError(text) {
    errorBox.textContent = text;
  }

  async function getPassword() {
    const stored = await browser.storage.local.get(PASSWORD_KEY);
    const value = stored[PASSWORD_KEY];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    await browser.storage.local.set({ [PASSWORD_KEY]: DEFAULT_PASSWORD });
    return DEFAULT_PASSWORD;
  }

  // Attempts are kept in storage.session so reloading the page does not reset them.
  async function getAttemptsLeft() {
    const stored = await browser.storage.session.get(ATTEMPTS_KEY);
    const value = stored[ATTEMPTS_KEY];
    return Number.isInteger(value) ? value : MAX_ATTEMPTS;
  }

  function setAttemptsLeft(value) {
    return browser.storage.session.set({ [ATTEMPTS_KEY]: value });
  }

  async function requestExit() {
    showError("Too many incorrect attempts. Closing the browser.");
    input.disabled = true;
    button.disabled = true;
    try {
      await browser.runtime.sendMessage({ action: "exit" });
    } catch (err) {
      // The page is probably already being closed.
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) {
      return;
    }
    busy = true;
    button.disabled = true;
    showError("");

    let finished = false;
    try {
      const attempt = input.value;
      const expected = await getPassword();

      if (attempt === expected) {
        await setAttemptsLeft(MAX_ATTEMPTS);
        let response = null;
        try {
          response = await browser.runtime.sendMessage({
            action: "unlock",
            password: attempt
          });
        } catch (err) {
          // The page can be closed before the reply arrives. That means success.
          finished = true;
          return;
        }
        if (response && response.ok) {
          finished = true;
          return;
        }
        showError("Unlock failed. Please try again.");
        return;
      }

      const left = Math.max((await getAttemptsLeft()) - 1, 0);
      await setAttemptsLeft(left);
      input.value = "";

      if (left <= 0) {
        finished = true;
        await requestExit();
        return;
      }
      showError(
        "Incorrect password. " + left + (left === 1 ? " attempt" : " attempts") + " remaining."
      );
    } catch (err) {
      showError("Unexpected error. Please try again.");
    } finally {
      busy = false;
      if (!finished) {
        button.disabled = false;
        input.focus();
      }
    }
  }

  form.addEventListener("submit", handleSubmit);

  // Block the context menu.
  document.addEventListener("contextmenu", (event) => event.preventDefault(), true);

  // Intercept common shortcuts. Page scripts cannot stop browser reserved keys
  // such as Ctrl+T, Ctrl+N or Ctrl+W; background.js handles those outcomes.
  document.addEventListener(
    "keydown",
    (event) => {
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey || event.metaKey;

      const blocked =
        event.key === "F12" ||
        event.key === "F5" ||
        (ctrl && ["u", "s", "p", "r", "l", "t", "n", "w", "o", "k"].includes(key)) ||
        (ctrl && event.shiftKey && ["i", "j", "c", "k", "n", "t", "r", "p", "delete"].includes(key)) ||
        (event.altKey && ["arrowleft", "arrowright", "home"].includes(key));

      if (blocked) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  // If the page is reloaded after all attempts were used, exit again.
  getAttemptsLeft()
    .then((left) => {
      if (left <= 0) {
        return requestExit();
      }
      input.focus();
      return null;
    })
    .catch(() => {});
})();
