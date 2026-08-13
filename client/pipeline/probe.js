/* global window */
/**
 * Metadata probe. Runs before anything is downloaded so the common failures —
 * private video, login wall, dead link, wrong URL — surface in a second instead of
 * halfway through a large download.
 */
(function () {
  "use strict";

  var proc = window.ZoinkProc;
  var tools = window.ZoinkTools;
  var errors = window.ZoinkErrors;

  var PLATFORMS = [
    { id: "youtube", label: "YouTube", test: /(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/i },
    { id: "instagram", label: "Instagram", test: /instagram\.com\/(?:p|reel|reels|tv)\//i },
    { id: "tiktok", label: "TikTok", test: /(?:tiktok\.com\/(?:@[^/]+\/video|t\/|v\/)|vm\.tiktok\.com\/)/i }
  ];

  /**
   * Pull a start time out of the link itself.
   *
   * A YouTube URL copied at a timestamp carries t=137s or t=1h2m3s, and that is
   * almost always exactly where the user wants their in point.
   */
  function extractStartTime(url) {
    var text = String(url || "");
    var match = text.match(/[?&#](?:t|start)=([0-9hms]+)/i);
    if (!match) {
      return null;
    }
    var value = match[1];

    if (/^\d+$/.test(value)) {
      return Number(value);
    }

    var parts = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
    if (!parts || (!parts[1] && !parts[2] && !parts[3])) {
      return null;
    }
    return (
      Number(parts[1] || 0) * 3600 +
      Number(parts[2] || 0) * 60 +
      Number(parts[3] || 0)
    );
  }

  function identify(url) {
    var text = String(url || "").trim();
    if (!/^https?:\/\//i.test(text)) {
      return { valid: false, reason: "That doesn't look like a link." };
    }
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (PLATFORMS[i].test.test(text)) {
        return { valid: true, supported: true, id: PLATFORMS[i].id, label: PLATFORMS[i].label };
      }
    }
    // yt-dlp handles well over a thousand sites; let anything through, but say so.
    return { valid: true, supported: false, id: "other", label: "unverified site" };
  }

  /** Shared yt-dlp arguments that depend on user settings rather than the task. */
  function authArgs(settings) {
    var args = [];
    if (settings.useCookies && settings.cookieBrowser) {
      args.push("--cookies-from-browser", settings.cookieBrowser);
    }
    if (settings.proxy) {
      args.push("--proxy", settings.proxy);
    }
    return args;
  }

  /**
   * Resolves { ok, title, duration, fps, uploader, ext, vcodec, acodec, isLive }.
   * Rejects with an Error carrying .friendly and .raw.
   */
  function probe(url, settings, onLog) {
    var ytdlp = tools.pathFor("yt-dlp");
    if (!ytdlp) {
      return Promise.reject(makeError("yt-dlp is not installed.", ""));
    }

    var args = ["-J", "--no-warnings", "--no-playlist"].concat(authArgs(settings), [url]);

    return proc
      .run(ytdlp, args, {
        onStderr: function (line) {
          if (onLog) {
            onLog(line);
          }
        }
      })
      .then(function (result) {
        if (result.code !== 0 || !result.stdout) {
          throw makeError(
            errors.explain(result.stderr, "Could not read that link."),
            result.stderr
          );
        }

        var info;
        try {
          info = JSON.parse(result.stdout);
        } catch (parseError) {
          throw makeError("yt-dlp returned something unreadable.", result.stdout);
        }

        if (info._type === "playlist") {
          // --no-playlist should have prevented this, but a channel URL can still
          // land here; take the first entry rather than failing outright.
          info = (info.entries && info.entries[0]) || info;
        }

        return {
          ok: true,
          title: info.title || "Untitled",
          id: info.id || "",
          duration: Number(info.duration) || 0,
          fps: Number(info.fps) || 0,
          width: Number(info.width) || 0,
          height: Number(info.height) || 0,
          uploader: info.uploader || info.channel || "",
          thumbnail: info.thumbnail || "",
          extractor: info.extractor_key || info.extractor || "",
          ext: info.ext || "",
          vcodec: info.vcodec || "",
          acodec: info.acodec || "",
          isLive: !!info.is_live,
          filesize:
            Number(info.filesize) || Number(info.filesize_approx) || 0
        };
      });
  }

  function makeError(friendly, raw) {
    var error = new Error(friendly);
    error.friendly = friendly;
    error.raw = raw || "";
    return error;
  }

  window.ZoinkProbe = {
    identify: identify,
    extractStartTime: extractStartTime,
    probe: probe,
    authArgs: authArgs,
    makeError: makeError
  };
})();
