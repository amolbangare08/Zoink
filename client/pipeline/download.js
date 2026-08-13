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

  var PROGRESS_PREFIX = "YKP|";
  var FILEPATH_PREFIX = "YKF|";

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
      "--print",
      "after_move:" + FILEPATH_PREFIX + "%(filepath)s",
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

  /**
   * yt-dlp announces the finished file in several ways depending on whether it
   * merged, remuxed, or skipped an already-present download. Check them in order of
   * how authoritative they are.
   */
  function resolveOutputPath(printed, stdout, stderr) {
    if (printed) {
      return printed;
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
      if (match) {
        return match[1].trim();
      }
    }
    return null;
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

    // A merged download reports progress for the video stream and then the audio
    // stream, so a naive percentage would run 0-100 twice.
    var expectedFiles = options.maxHeight === "audio" ? 1 : 2;
    var completedFiles = 0;
    var printedPath = null;
    var lastBytes = 0;

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

      if (line.indexOf(FILEPATH_PREFIX) === 0) {
        printedPath = line.slice(FILEPATH_PREFIX.length).trim();
        return;
      }

      if (options.onLog) {
        options.onLog(line);
      }
    }

    var running = proc.run(ytdlp, buildArgs(options), {
      onStdout: handleLine,
      onStderr: handleLine
    });

    var promise = running.then(function (result) {
      if (result.signal || result.code === null) {
        throw probeModule.makeError("Cancelled.", "");
      }
      if (result.code !== 0) {
        throw probeModule.makeError(
          errors.explain(result.stderr + result.stdout, "The download failed."),
          errors.firstErrorLine(result.stderr || result.stdout)
        );
      }

      var filePath = resolveOutputPath(printedPath, result.stdout, result.stderr);
      if (!filePath || !fs.existsSync(filePath)) {
        throw probeModule.makeError(
          "The download finished but the file could not be found.",
          filePath || "(no path reported)"
        );
      }

      return { filePath: filePath, bytes: lastBytes };
    });

    promise.cancel = function () {
      running.cancel();
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
