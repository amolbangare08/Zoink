/* global window */
/**
 * yt-dlp download step.
 *
 * The important trick here is --download-sections: when the user sets in/out
 * points, yt-dlp requests only the byte ranges covering that window, so pulling 40
 * seconds out of a 3-hour VOD costs 40 seconds of bandwidth and disk, not 3 hours.
 */
(function () {
  "use strict";

  var proc = window.ZoinkProc;
  var tools = window.ZoinkTools;
  var probeModule = window.ZoinkProbe;
  var errors = window.ZoinkErrors;
  var time = window.ZoinkTime;

  var fs = proc.require("fs");
  var path = proc.require("path");
  var os = proc.require("os");

  var PROGRESS_PREFIX = "YKP|";

  function formatSelector(maxHeight) {
    if (!maxHeight || maxHeight === "best") {
      return "bv*+ba/b";
    }
    var height = Number(maxHeight);
    return (
      "bv*[height<=" + height + "]+ba/b[height<=" + height + "]/wv*+ba/w"
    );
  }

  function sectionArgs(inSeconds, outSeconds, frameAccurate) {
    if (inSeconds === null && outSeconds === null) {
      return [];
    }
    var start = time.format(inSeconds || 0);
    var end = outSeconds === null ? "inf" : time.format(outSeconds);
    var args = ["--download-sections", "*" + start + "-" + end];
    if (frameAccurate) {
      // Re-encodes the boundary GOPs so the cut lands on the requested frame
      // instead of the nearest keyframe. Slower, but an editor asking for
      // 1:20:00 expects 1:20:00.
      args.push("--force-keyframes-at-cuts");
    }
    return args;
  }

  function outputTemplate(workDir, inSeconds, outSeconds) {
    var suffix = "";
    if (inSeconds !== null || outSeconds !== null) {
      // Different slices of the same video must not collide on disk.
      suffix =
        " [" +
        Math.round(inSeconds || 0) +
        "-" +
        (outSeconds === null ? "end" : Math.round(outSeconds)) +
        "]";
    }
    return path.join(workDir, "%(title).80s [%(id)s]" + suffix + ".%(ext)s");
  }

  function buildArgs(options) {
    var args = [
      "--no-playlist",
      "--no-warnings",
      "-f",
      formatSelector(options.maxHeight),
      "--merge-output-format",
      "mp4",
      "--newline",
      "--progress",
      "--no-simulate",
      "--progress-template",
      "download:" +
        PROGRESS_PREFIX +
        "%(progress.downloaded_bytes)s|%(progress.total_bytes)s|" +
        "%(progress.total_bytes_estimate)s|%(progress.speed)s|" +
        "%(progress.eta)s|%(progress.status)s",
      // The finished path goes to a sidecar file, never to stdout. yt-dlp encodes
      // console output with errors='ignore', so on a Windows cp1252 console every
      // character outside the code page is silently dropped — and yt-dlp's own
      // filename sanitiser produces exactly such characters (| becomes U+FF5C).
      // The path printed to a file is written as UTF-8 and survives intact.
      "--print-to-file",
      "after_move:%(filepath)s",
      options.sidecarPath,
      "-o",
      outputTemplate(options.workDir, options.inSeconds, options.outSeconds)
    ];

    var ffmpegDir = tools.ffmpegDir();
    if (ffmpegDir) {
      args.push("--ffmpeg-location", ffmpegDir);
    }

    args = args.concat(
      sectionArgs(options.inSeconds, options.outSeconds, options.frameAccurate),
      probeModule.authArgs(options.settings),
      [options.url]
    );
    return args;
  }

  function toNumber(text) {
    var value = Number(text);
    return isFinite(value) && value > 0 ? value : 0;
  }

  /** The path yt-dlp wrote to its sidecar file, read back as UTF-8. */
  function readSidecar(sidecarPath) {
    try {
      var text = fs.readFileSync(sidecarPath, "utf8").trim();
      if (!text.length) {
        return null;
      }
      // The file is appended to, so the last line is this run's output.
      var lines = text.split(/\r?\n/);
      return lines[lines.length - 1].trim() || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Last resort: the newest finished file the run left in the folder. Filenames
   * coming back through the console are lossy, so this catches the case where
   * every reported path is unusable but the download itself worked.
   */
  function newestFileSince(workDir, sinceMs) {
    var best = null;
    var bestTime = 0;
    try {
      fs.readdirSync(workDir).forEach(function (name) {
        if (/\.(part|ytdl|temp)$/i.test(name)) {
          return;
        }
        var full = path.join(workDir, name);
        var stat;
        try {
          stat = fs.statSync(full);
        } catch (error) {
          return;
        }
        if (!stat.isFile()) {
          return;
        }
        var modified = stat.mtimeMs || stat.mtime.getTime();
        if (modified >= sinceMs && modified > bestTime) {
          best = full;
          bestTime = modified;
        }
      });
    } catch (error) {
      return null;
    }
    return best;
  }

  /**
   * yt-dlp announces the finished file in several ways depending on whether it
   * merged, remuxed, or skipped an already-present download. The sidecar is the
   * only lossless source; the console patterns below can have characters stripped
   * by the Windows code page, so they are checked for existence before use.
   */
  function resolveOutputPath(sidecarPath, stdout, stderr, workDir, startedAt) {
    var fromSidecar = readSidecar(sidecarPath);
    if (fromSidecar && fs.existsSync(fromSidecar)) {
      return fromSidecar;
    }

    var all = String(stdout || "") + "\n" + String(stderr || "");
    var patterns = [
      /\[Merger\] Merging formats into "([^"]+)"/,
      /\[download\] (.+?) has already been downloaded/,
      /\[VideoRemuxer\] Remuxing video from \S+ to \S+; Destination: (.+)/,
      /\[download\] Destination: (.+)/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var match = all.match(patterns[i]);
      if (match && fs.existsSync(match[1].trim())) {
        return match[1].trim();
      }
    }

    return newestFileSince(workDir, startedAt);
  }

  /**
   * Run the download.
   *
   * options: { url, workDir, maxHeight, inSeconds, outSeconds, frameAccurate,
   *            settings, onProgress(fraction, detail), onLog(line) }
   * Returns a promise for { filePath, bytes } with a .cancel() attached.
   */
  function download(options) {
    var ytdlp = tools.pathFor("yt-dlp");
    if (!ytdlp) {
      return Promise.reject(probeModule.makeError("yt-dlp is not installed.", ""));
    }

    try {
      fs.mkdirSync(options.workDir, { recursive: true });
    } catch (error) {
      return Promise.reject(
        probeModule.makeError(
          "Could not create the download folder: " + options.workDir,
          String(error)
        )
      );
    }

    var sidecarPath = path.join(
      os.tmpdir(),
      "zoink-" + Date.now() + "-" + Math.floor(Math.random() * 100000) + ".path"
    );
    var hasRange = options.inSeconds !== null || options.outSeconds !== null;
    var cancelled = false;
    var current = null;
    var lastBytes = 0;

    function attempt(frameAccurate) {
      // Allow a little slack: the merged file can carry a timestamp from just
      // before the process was spawned.
      var startedAt = Date.now() - 5000;

      // A merged download reports progress for the video stream and then the
      // audio stream, so a naive percentage would run 0-100 twice.
      var expectedFiles = options.maxHeight === "audio" ? 1 : 2;
      var completedFiles = 0;

      try {
        fs.unlinkSync(sidecarPath);
      } catch (error) {
        /* not there yet, which is the normal case */
      }

      function handleLine(line) {
        if (line.indexOf(PROGRESS_PREFIX) === 0) {
          var parts = line.slice(PROGRESS_PREFIX.length).split("|");
          var downloaded = toNumber(parts[0]);
          var total = toNumber(parts[1]) || toNumber(parts[2]);
          var speed = toNumber(parts[3]);
          var eta = toNumber(parts[4]);
          var status = parts[5];

          lastBytes = downloaded;
          if (status === "finished") {
            completedFiles = Math.min(completedFiles + 1, expectedFiles);
          }

          var fileFraction = total ? Math.min(downloaded / total, 1) : 0;
          var overall = Math.min(
            (completedFiles + fileFraction) / expectedFiles,
            1
          );
          if (options.onProgress) {
            options.onProgress(overall, {
              downloaded: downloaded,
              total: total,
              speed: speed,
              eta: eta
            });
          }
          return;
        }

        if (options.onLog) {
          options.onLog(line);
        }
      }

      var running = proc.run(
        ytdlp,
        buildArgs({
          url: options.url,
          workDir: options.workDir,
          maxHeight: options.maxHeight,
          inSeconds: options.inSeconds,
          outSeconds: options.outSeconds,
          frameAccurate: frameAccurate,
          settings: options.settings,
          sidecarPath: sidecarPath
        }),
        { onStdout: handleLine, onStderr: handleLine }
      );
      current = running;

      return running.then(function (result) {
        if (cancelled || result.signal || result.code === null) {
          throw probeModule.makeError("Cancelled.", "");
        }

        if (result.code !== 0) {
          var raw = String(result.stderr || "") + "\n" + String(result.stdout || "");

          // --force-keyframes-at-cuts re-encodes the cut boundaries, and that
          // encode can crash outright on some sources. A keyframe-aligned cut is
          // far better than no clip at all, so signal a retry rather than failing.
          if (frameAccurate && hasRange && /ffmpeg exited with code/i.test(raw)) {
            var retryError = probeModule.makeError(
              "Frame-accurate cutting crashed ffmpeg.",
              errors.firstErrorLine(raw)
            );
            retryError.keyframeRetry = true;
            throw retryError;
          }

          throw probeModule.makeError(
            errors.explain(raw, "The download failed."),
            errors.firstErrorLine(raw)
          );
        }

        var filePath = resolveOutputPath(
          sidecarPath,
          result.stdout,
          result.stderr,
          options.workDir,
          startedAt
        );
        if (!filePath || !fs.existsSync(filePath)) {
          throw probeModule.makeError(
            "The download finished but the file could not be found.",
            filePath || "(no path reported)"
          );
        }

        return { filePath: filePath, bytes: lastBytes };
      });
    }

    function cleanupSidecar() {
      try {
        fs.unlinkSync(sidecarPath);
      } catch (error) {
        /* nothing to remove */
      }
    }

    var promise = attempt(!!options.frameAccurate)
      .catch(function (error) {
        if (cancelled || !error.keyframeRetry) {
          throw error;
        }
        if (options.onLog) {
          options.onLog(
            "Frame-accurate cutting crashed ffmpeg — retrying with a keyframe-aligned cut."
          );
        }
        return attempt(false).catch(function (retryError) {
          // The crash reproduces only on the anonymous fetch path — signed-in
          // requests get formats ffmpeg can cut. So if dropping frame accuracy
          // did not help either, cookies are the next thing worth trying.
          if (!cancelled) {
            retryError.tryCookies = true;
          }
          throw retryError;
        });
      })
      .then(
        function (result) {
          cleanupSidecar();
          return result;
        },
        function (error) {
          cleanupSidecar();
          throw error;
        }
      );

    promise.cancel = function () {
      cancelled = true;
      if (current) {
        current.cancel();
      }
      cleanPartials(options.workDir);
    };
    return promise;
  }

  /** Remove yt-dlp's resume fragments after a cancel so the folder stays clean. */
  function cleanPartials(workDir) {
    try {
      fs.readdirSync(workDir).forEach(function (name) {
        if (/\.(part|ytdl|temp)$/i.test(name) || /\.part-Frag\d+$/i.test(name)) {
          try {
            fs.unlinkSync(path.join(workDir, name));
          } catch (ignored) {
            /* the file may still be locked; leaving it is harmless */
          }
        }
      });
    } catch (ignored) {
      /* folder may not exist yet */
    }
  }

  window.ZoinkDownload = {
    download: download,
    buildArgs: buildArgs,
    formatSelector: formatSelector,
    cleanPartials: cleanPartials
  };
})();
