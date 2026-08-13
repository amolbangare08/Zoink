/* global window */
/**
 * Turns raw yt-dlp / ffmpeg stderr into one sentence an editor can act on.
 *
 * The raw text still goes to the log pane; this only decides what the status line
 * says. Order matters — the first matching rule wins, so put specific patterns
 * above general ones.
 */
(function () {
  "use strict";

  var RULES = [
    {
      test: /Private video|Sign in to confirm|login required|requires authentication|This video is only available to Music Premium/i,
      message:
        "This post needs a signed-in session. Turn on browser cookies in Settings and try again."
    },
    {
      test: /confirm your age|age-restricted|Sign in to confirm your age/i,
      message:
        "Age-restricted video. Turn on browser cookies in Settings so yt-dlp can use your signed-in session."
    },
    {
      // yt-dlp cannot copy a Chromium cookie database while the browser holds a
      // lock on it, which on Windows means Chrome, Edge and Brave must be closed.
      test: /Could not copy Chrome cookie database/i,
      message:
        "Close that browser completely and try again — its cookie database is locked. Firefox works without closing it."
    },
    {
      test: /could not find .* cookies database|could not find .* profile/i,
      message: "That browser isn't installed here. Pick a different one in Settings."
    },
    {
      test: /HTTP Error 429|Too Many Requests/i,
      message: "Rate limited by the site. Wait a few minutes, or set a proxy in Settings."
    },
    {
      test: /HTTP Error 40[13]|Forbidden/i,
      message:
        "Access denied. Try enabling browser cookies in Settings, or update yt-dlp."
    },
    {
      test: /HTTP Error 404|Video unavailable|has been removed|no longer available/i,
      message: "That video is unavailable — removed, private, or the link is wrong."
    },
    {
      test: /not available in your country|geo restricted|blocked it in your country/i,
      message: "Blocked in your region. A proxy in Settings may get around it."
    },
    {
      test: /Unsupported URL/i,
      message: "That link isn't supported. Check it points at a single video."
    },
    {
      test: /Unable to extract|unable to download webpage|Failed to parse JSON|nsig extraction failed/i,
      message:
        "The extractor is out of date for this site. Run Check for updates in Settings."
    },
    {
      test: /ffmpeg (?:not found|is not installed)|ffprobe (?:not found|is not installed)/i,
      message: "ffmpeg is missing. Install it, or drop ffmpeg into the extension's bin folder."
    },
    {
      test: /is not recognized as an internal or external command|ENOENT/i,
      message: "A required tool could not be launched. Check the tool paths in Settings."
    },
    {
      test: /No space left on device|not enough space/i,
      message: "The download drive is out of space."
    },
    {
      test: /Invalid data found when processing input|moov atom not found/i,
      message: "The downloaded file is corrupt or incomplete. Try again."
    },
    {
      test: /Permission denied|EACCES|EPERM/i,
      message: "Permission denied writing to the download folder. Pick another folder in Settings."
    }
  ];

  function explain(rawText, fallback) {
    var text = String(rawText || "");
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i].test.test(text)) {
        return RULES[i].message;
      }
    }
    return fallback || "Something went wrong. Check the log below for details.";
  }

  /** Pull the most useful line out of a wall of stderr for the log summary. */
  function firstErrorLine(rawText) {
    var lines = String(rawText || "").split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (/^ERROR|^\[.*\] ERROR|error:/i.test(lines[i])) {
        return lines[i].trim();
      }
    }
    return lines[lines.length - 1] || "";
  }

  /**
   * Is this failure the kind that a signed-in session usually fixes?
   *
   * YouTube's bot gate and the 403s it hands out for media URLs both clear once
   * yt-dlp can present real cookies, so this decides whether retrying is worth a
   * second round trip. Matched against raw stderr and against our own mapped
   * message, since either may be all the caller kept.
   */
  var AUTH_WALL =
    /Sign in to confirm|not a bot|HTTP Error 40[13]|Forbidden|Private video|age.restricted|login required|requires authentication|signed-in session|enabling browser cookies/i;

  function isAuthWall(rawText) {
    return AUTH_WALL.test(String(rawText || ""));
  }

  window.ZoinkErrors = {
    explain: explain,
    firstErrorLine: firstErrorLine,
    isAuthWall: isAuthWall
  };
})();
