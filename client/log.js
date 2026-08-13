/* global window, document */
/**
 * The console pane. Append-only, capped, and it stops auto-scrolling the moment the
 * user scrolls up to read something.
 */
(function () {
  "use strict";

  var MAX_LINES = 500;

  var element = null;
  var pinnedToBottom = true;

  function attach(node) {
    element = node;
    element.addEventListener("scroll", function () {
      var distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottom = distanceFromBottom < 24;
    });
  }

  function write(text, kind) {
    if (!element) {
      return;
    }
    var line = document.createElement("div");
    line.className = "log-line" + (kind ? " log-" + kind : "");
    line.textContent = String(text);
    element.appendChild(line);

    while (element.childNodes.length > MAX_LINES) {
      element.removeChild(element.firstChild);
    }
    if (pinnedToBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }

  function info(text) {
    write(text, null);
  }
  function good(text) {
    write(text, "ok");
  }
  function warn(text) {
    write(text, "warn");
  }
  function error(text) {
    write(text, "error");
  }
  function muted(text) {
    write(text, "muted");
  }

  function clear() {
    if (element) {
      element.innerHTML = "";
    }
  }

  function copyAll() {
    if (!element) {
      return "";
    }
    var lines = [];
    for (var i = 0; i < element.childNodes.length; i++) {
      lines.push(element.childNodes[i].textContent);
    }
    return lines.join("\n");
  }

  window.ZoinkLog = {
    attach: attach,
    info: info,
    good: good,
    warn: warn,
    error: error,
    muted: muted,
    clear: clear,
    copyAll: copyAll
  };
})();
