"use strict";

(() => {
  const form = document.getElementById("change-form");
  const currentInput = document.getElementById("current");
  const nextInput = document.getElementById("next");
  const confirmInput = document.getElementById("confirm");
  const saveButton = document.getElementById("save-btn");
  const statusBox = document.getElementById("status");
  const defaultNotice = document.getElementById("default-notice");

  const MESSAGES = {
    "wrong-current": "The current password is incorrect.",
    "too-short": "The new password must be at least " + FoxAuth.MIN_LENGTH + " characters.",
    "too-long": "The new password must be at most " + FoxAuth.MAX_LENGTH + " characters.",
    "is-default": "The new password cannot be the default password.",
    "same-as-current": "The new password must be different from the current one."
  };

  let busy = false;

  function setStatus(text, kind) {
    statusBox.textContent = text;
    statusBox.className = kind || "";
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy) {
      return;
    }

    if (nextInput.value !== confirmInput.value) {
      setStatus("The new password and the confirmation do not match.", "error");
      return;
    }

    busy = true;
    saveButton.disabled = true;
    setStatus("");

    try {
      const result = await FoxAuth.changePassword(currentInput.value, nextInput.value);
      if (result.ok) {
        form.reset();
        defaultNotice.hidden = true;
        setStatus("Password changed. Use it the next time Firefox starts.", "success");
      } else {
        setStatus(MESSAGES[result.reason] || "Could not change the password.", "error");
        currentInput.focus();
      }
    } catch (err) {
      setStatus("Unexpected error. The password was not changed.", "error");
    } finally {
      busy = false;
      saveButton.disabled = false;
    }
  }

  form.addEventListener("submit", handleSubmit);

  FoxAuth.usesDefaultPassword()
    .then((isDefault) => {
      defaultNotice.hidden = !isDefault;
    })
    .catch(() => {});
})();
