/* global window, CSInterface, SystemPath */
/**
 * Resolves the external binaries ZOINK depends on.
 *
 * Search order for each tool: a bundled copy in bin/, then an explicit path from
 * settings, then PATH. Bundled wins so a shipped build is self-contained even on a
 * machine that already has an ancient yt-dlp installed.
 */
(function () {
  "use strict";

  var proc = window.ZoinkProc;
  var fs = proc.require("fs");
  var path = proc.require("path");

  var TOOL_NAMES = ["yt-dlp", "ffmpeg", "ffprobe"];

  var state = {
    extensionRoot: "",
    binDir: "",
    resolved: {},
    versions: {},
    sources: {}
  };

  function extensionRoot() {
    if (!state.extensionRoot) {
      var cs = new CSInterface();
      state.extensionRoot = cs.getSystemPath(SystemPath.EXTENSION);
      state.binDir = path.join(state.extensionRoot, "bin");
    }
    return state.extensionRoot;
  }

  function bundledPath(name) {
    extensionRoot();
    var candidate = path.join(
      state.binDir,
      proc.isWindows ? name + ".exe" : name
    );
    try {
      return fs.existsSync(candidate) ? candidate : null;
    } catch (error) {
      return null;
    }
  }

  function overridePath(name, settings) {
    var key = name.replace("-", "") + "Path"; // yt-dlp -> ytdlpPath
    var value = settings && settings[key];
    if (!value) {
      return null;
    }
    try {
      return fs.existsSync(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  function resolveOne(name, settings) {
    var bundled = bundledPath(name);
    if (bundled) {
      state.sources[name] = "bundled";
      return Promise.resolve(bundled);
    }
    var override = overridePath(name, settings);
    if (override) {
      state.sources[name] = "settings";
      return Promise.resolve(override);
    }
    return proc.which(name).then(function (found) {
      state.sources[name] = found ? "PATH" : "missing";
      return found;
    });
  }

  function versionArgs(name) {
    return name === "yt-dlp" ? ["--version"] : ["-version"];
  }

  function firstLine(text) {
    return String(text || "").split(/\r?\n/)[0].trim();
  }

  /**
   * Resolve every tool and read its version. Never rejects — a missing tool is a
   * reported state, not an exception, because the panel has to render either way.
   */
  function detect(settings) {
    extensionRoot();
    var jobs = TOOL_NAMES.map(function (name) {
      return resolveOne(name, settings).then(function (resolvedPath) {
        state.resolved[name] = resolvedPath;
        if (!resolvedPath) {
          state.versions[name] = null;
          return;
        }
        return proc
          .run(resolvedPath, versionArgs(name))
          .then(function (result) {
            state.versions[name] = firstLine(result.stdout || result.stderr);
          })
          .catch(function () {
            state.versions[name] = null;
          });
      });
    });

    return Promise.all(jobs).then(function () {
      return {
        extensionRoot: state.extensionRoot,
        binDir: state.binDir,
        paths: state.resolved,
        versions: state.versions,
        sources: state.sources,
        missing: TOOL_NAMES.filter(function (name) {
          return !state.resolved[name];
        })
      };
    });
  }

  function pathFor(name) {
    return state.resolved[name] || null;
  }

  /** Directory holding ffmpeg, handed to yt-dlp via --ffmpeg-location. */
  function ffmpegDir() {
    var ffmpeg = pathFor("ffmpeg");
    return ffmpeg ? path.dirname(ffmpeg) : null;
  }

  /** yt-dlp version strings are dates (2025.09.26); flag builds that have aged out. */
  function ytdlpAgeDays() {
    var version = state.versions["yt-dlp"];
    var match = version && version.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (!match) {
      return null;
    }
    var built = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    );
    return Math.floor((Date.now() - built.getTime()) / 86400000);
  }

  /** Does this ffmpeg build have an NVIDIA hardware encoder compiled in? */
  function hasNvenc() {
    var ffmpeg = pathFor("ffmpeg");
    if (!ffmpeg) {
      return Promise.resolve(false);
    }
    return proc
      .run(ffmpeg, ["-hide_banner", "-encoders"])
      .then(function (result) {
        return /h264_nvenc/.test(result.stdout + result.stderr);
      })
      .catch(function () {
        return false;
      });
  }

  function selfUpdate(onLine) {
    var ytdlp = pathFor("yt-dlp");
    if (!ytdlp) {
      return Promise.reject(new Error("yt-dlp is not installed."));
    }
    if (state.sources["yt-dlp"] === "PATH" && /python|scripts/i.test(ytdlp)) {
      return Promise.reject(
        new Error(
          "This yt-dlp came from pip. Update it with: python -m pip install -U yt-dlp"
        )
      );
    }
    return proc.run(ytdlp, ["-U"], { onStdout: onLine, onStderr: onLine });
  }

  window.ZoinkTools = {
    detect: detect,
    pathFor: pathFor,
    ffmpegDir: ffmpegDir,
    ytdlpAgeDays: ytdlpAgeDays,
    hasNvenc: hasNvenc,
    selfUpdate: selfUpdate,
    extensionRoot: extensionRoot,
    sources: state.sources,
    versions: state.versions
  };
})();
