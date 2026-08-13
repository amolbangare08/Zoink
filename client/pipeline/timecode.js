/* global window */
/**
 * In/out point parsing. Editors type times in whatever shape is quickest, so accept
 * SS, MM:SS, HH:MM:SS and any of those with a decimal fraction.
 */
(function () {
  "use strict";

  var NUMBER = /^\d+(?:[.,]\d{1,3})?$/;

  /** Returns seconds as a Number, or null when the text is not a valid time. */
  function parse(text) {
    if (text === null || text === undefined) {
      return null;
    }
    var trimmed = String(text).trim();
    if (!trimmed.length) {
      return null;
    }

    var parts = trimmed.split(":");
    if (parts.length > 3) {
      return null;
    }

    var values = [];
    for (var i = 0; i < parts.length; i++) {
      if (!NUMBER.test(parts[i])) {
        return null;
      }
      values.push(Number(parts[i].replace(",", ".")));
    }

    // A bare number is a plain second count, so "500" means 500s, not 5 minutes.
    // Once a colon appears, the smaller fields have to be real clock values.
    if (values.length === 1) {
      return values[0];
    }
    if (values[values.length - 1] >= 60) {
      return null;
    }
    if (values.length === 2) {
      return values[0] * 60 + values[1];
    }
    if (values[1] >= 60) {
      return null;
    }
    return values[0] * 3600 + values[1] * 60 + values[2];
  }

  /** Seconds to the HH:MM:SS.mmm form yt-dlp's --download-sections expects. */
  function format(totalSeconds) {
    var value = Math.max(0, Number(totalSeconds) || 0);
    var hours = Math.floor(value / 3600);
    var minutes = Math.floor((value % 3600) / 60);
    var seconds = value % 60;
    return (
      pad(hours) +
      ":" +
      pad(minutes) +
      ":" +
      (seconds < 10 ? "0" : "") +
      seconds.toFixed(3)
    );
  }

  /**
   * Canonical form for the in/out fields: the shortest clock notation that still
   * reads unambiguously, keeping any fraction the user typed.
   * 15 -> "0:15", 500 -> "8:20", 5025 -> "1:23:45", 2.5 -> "0:02.5"
   */
  function display(totalSeconds) {
    var value = Math.max(0, Number(totalSeconds) || 0);
    var whole = Math.floor(value);
    var fraction = value - whole;
    var text = pretty(whole);

    if (fraction > 0.0005) {
      // Trim trailing zeros so 2.500 shows as 2.5, not 2.500.
      text += fraction.toFixed(3).replace(/^0/, "").replace(/0+$/, "");
    }
    return text;
  }

  /** Human-readable duration for the log pane. */
  function pretty(totalSeconds) {
    var value = Math.round(Number(totalSeconds) || 0);
    var hours = Math.floor(value / 3600);
    var minutes = Math.floor((value % 3600) / 60);
    var seconds = value % 60;
    if (hours) {
      return hours + ":" + pad(minutes) + ":" + pad(seconds);
    }
    return minutes + ":" + pad(seconds);
  }

  function pad(value) {
    return (value < 10 ? "0" : "") + value;
  }

  /**
   * Validate a requested range against the real duration.
   * Returns { ok, inSeconds, outSeconds, message }.
   */
  function validateRange(inText, outText, durationSeconds) {
    var hasIn = String(inText || "").trim().length > 0;
    var hasOut = String(outText || "").trim().length > 0;
    if (!hasIn && !hasOut) {
      return { ok: true, inSeconds: null, outSeconds: null };
    }

    var inSeconds = hasIn ? parse(inText) : 0;
    if (inSeconds === null) {
      return { ok: false, message: 'In point "' + inText + '" is not a valid time.' };
    }

    var outSeconds = hasOut ? parse(outText) : null;
    if (hasOut && outSeconds === null) {
      return { ok: false, message: 'Out point "' + outText + '" is not a valid time.' };
    }

    if (outSeconds !== null && outSeconds <= inSeconds) {
      return { ok: false, message: "The out point must come after the in point." };
    }
    if (durationSeconds && inSeconds >= durationSeconds) {
      return {
        ok: false,
        message:
          "The in point is past the end of the video (" +
          pretty(durationSeconds) +
          ")."
      };
    }
    if (durationSeconds && outSeconds !== null && outSeconds > durationSeconds) {
      // Clamp instead of failing: asking for more than exists is a harmless typo.
      outSeconds = durationSeconds;
    }

    return { ok: true, inSeconds: inSeconds, outSeconds: outSeconds };
  }

  window.ZoinkTime = {
    parse: parse,
    format: format,
    display: display,
    pretty: pretty,
    validateRange: validateRange
  };
})();
