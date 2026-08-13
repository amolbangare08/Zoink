/* global window */
/**
 * Conform step — the "edit-safe H.264" promise.
 *
 * The real job here is variable frame rate. TikTok and Instagram hand out VFR
 * files; dropped straight into Premiere they drift out of sync as the clip plays.
 * Anything already H.264 / yuv420p / AAC / CFR skips this step entirely, so a clean
 * YouTube grab costs nothing.
 */
(function () {
  "use strict";

  var proc = window.ZoinkProc;
  var tools = window.ZoinkTools;
  var probeModule = window.ZoinkProbe;
  var errors = window.ZoinkErrors;

  var fs = proc.require("fs");
  var path = proc.require("path");

  var STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

  function parseRational(text) {
    if (!text) {
      return 0;
    }
    var parts = String(text).split("/");
    var numerator = Number(parts[0]);
    var denominator = parts.length > 1 ? Number(parts[1]) : 1;
    if (!denominator || !isFinite(numerator)) {
      return 0;
    }
    return numerator / denominator;
  }

  function snapToStandardRate(fps) {
    if (!fps) {
      return 30;
    }
    var best = STANDARD_RATES[0];
    var bestGap = Math.abs(fps - best);
    for (var i = 1; i < STANDARD_RATES.length; i++) {
      var gap = Math.abs(fps - STANDARD_RATES[i]);
      if (gap < bestGap) {
        best = STANDARD_RATES[i];
        bestGap = gap;
      }
    }
    // More than 1fps away from every standard rate: keep what the file claims.
    return bestGap <= 1 ? best : Math.round(fps * 1000) / 1000;
  }

  function inspect(filePath) {
    var ffprobe = tools.pathFor("ffprobe");
    if (!ffprobe) {
      return Promise.resolve(null);
    }
    return proc
      .run(ffprobe, [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        filePath
      ])
      .then(function (result) {
        if (result.code !== 0 || !result.stdout) {
          return null;
        }
        var data;
        try {
          data = JSON.parse(result.stdout);
        } catch (error) {
          return null;
        }

        var video = null;
        var audio = null;
        (data.streams || []).forEach(function (stream) {
          if (!video && stream.codec_type === "video") {
            video = stream;
          }
          if (!audio && stream.codec_type === "audio") {
            audio = stream;
          }
        });

        var realFps = video ? parseRational(video.r_frame_rate) : 0;
        var averageFps = video ? parseRational(video.avg_frame_rate) : 0;

        return {
          hasVideo: !!video,
          hasAudio: !!audio,
          vcodec: video ? video.codec_name : "",
          pixelFormat: video ? video.pix_fmt : "",
          acodec: audio ? audio.codec_name : "",
          width: video ? Number(video.width) : 0,
          height: video ? Number(video.height) : 0,
          realFps: realFps,
          averageFps: averageFps,
          // A VFR file reports a nominal rate that its average does not match.
          isVariableFrameRate:
            !!video &&
            realFps > 0 &&
            averageFps > 0 &&
            Math.abs(realFps - averageFps) / realFps > 0.01,
          duration: Number(data.format && data.format.duration) || 0,
          formatName: (data.format && data.format.format_name) || ""
        };
      })
      .catch(function () {
        return null;
      });
  }

  /** Decide whether the file can go straight to the timeline. */
  function needsConform(info, filePath) {
    if (!info) {
      // Without ffprobe we cannot tell, so transcode to be safe.
      return { conform: true, reason: "could not inspect the file" };
    }
    if (!info.hasVideo) {
      return { conform: false, reason: "audio-only file" };
    }
    if (info.isVariableFrameRate) {
      return { conform: true, reason: "variable frame rate" };
    }
    if (info.vcodec !== "h264") {
      return { conform: true, reason: info.vcodec + " video" };
    }
    if (info.pixelFormat && info.pixelFormat !== "yuv420p") {
      return { conform: true, reason: info.pixelFormat + " pixel format" };
    }
    if (info.hasAudio && info.acodec !== "aac") {
      return { conform: true, reason: info.acodec + " audio" };
    }
    if (!/mp4|mov/.test(info.formatName) || !/\.mp4$/i.test(filePath)) {
      return { conform: true, reason: "non-MP4 container" };
    }
    return { conform: false, reason: "already H.264 MP4 at a constant frame rate" };
  }

  function ffmpegMajorVersion() {
    var version = tools.versions && tools.versions.ffmpeg;
    var match = version && version.match(/version\s+n?(\d+)/i);
    return match ? Number(match[1]) : 0;
  }

  function conformOutputPath(inputPath) {
    var dir = path.dirname(inputPath);
    var base = path.basename(inputPath, path.extname(inputPath));
    return path.join(dir, base + " [edit-safe].mp4");
  }

  function buildArgs(options) {
    var info = options.info || {};
    var fps = snapToStandardRate(
      options.targetFps || info.averageFps || info.realFps || 30
    );

    var args = ["-hide_banner", "-y", "-i", options.inputPath];

    if (options.useNvenc) {
      args.push("-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "20");
    } else {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18");
    }
    args.push("-profile:v", "high", "-pix_fmt", "yuv420p");

    // The whole point of the step: pin every frame to a fixed cadence.
    args.push("-r", String(fps));
    args.push(ffmpegMajorVersion() >= 5 ? "-fps_mode" : "-vsync", "cfr");

    if (info.hasAudio === false) {
      args.push("-an");
    } else {
      args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
    }

    args.push("-movflags", "+faststart");
    args.push("-progress", "pipe:1", "-nostats");
    args.push(options.outputPath);
    return args;
  }

  /**
   * options: { inputPath, targetFps, useNvenc, keepOriginal,
   *            onProgress(fraction), onLog(line) }
   * Resolves { filePath, skipped, reason } with .cancel() attached.
   */
  function conform(options) {
    var ffmpeg = tools.pathFor("ffmpeg");
    var cancelled = false;
    var running = null;

    var promise = inspect(options.inputPath).then(function (info) {
      var decision = needsConform(info, options.inputPath);
      if (!decision.conform) {
        if (options.onLog) {
          options.onLog("Skipping encode — " + decision.reason + ".");
        }
        if (options.onProgress) {
          options.onProgress(1);
        }
        return { filePath: options.inputPath, skipped: true, reason: decision.reason, info: info };
      }

      if (!ffmpeg) {
        throw probeModule.makeError(
          "ffmpeg is missing, so the file could not be made edit-safe.",
          ""
        );
      }
      if (cancelled) {
        throw probeModule.makeError("Cancelled.", "");
      }

      var outputPath = conformOutputPath(options.inputPath);
      var duration = (info && info.duration) || 0;
      if (options.onLog) {
        options.onLog("Conforming — " + decision.reason + ".");
      }

      running = proc.run(
        ffmpeg,
        buildArgs({
          inputPath: options.inputPath,
          outputPath: outputPath,
          info: info,
          targetFps: options.targetFps,
          useNvenc: options.useNvenc
        }),
        {
          onStdout: function (line) {
            var match = line.match(/^out_time_us=(\d+)/);
            if (match && duration > 0 && options.onProgress) {
              var seconds = Number(match[1]) / 1000000;
              options.onProgress(Math.min(seconds / duration, 1));
            }
          },
          onStderr: function (line) {
            if (options.onLog && !/^\s*$/.test(line)) {
              options.onLog(line);
            }
          }
        }
      );

      return running.then(function (result) {
        if (cancelled || result.signal) {
          throw probeModule.makeError("Cancelled.", "");
        }
        if (result.code !== 0 || !fs.existsSync(outputPath)) {
          throw probeModule.makeError(
            errors.explain(result.stderr, "The encode failed."),
            errors.firstErrorLine(result.stderr)
          );
        }
        if (!options.keepOriginal) {
          try {
            fs.unlinkSync(options.inputPath);
          } catch (ignored) {
            /* leaving the source behind is not worth failing the job over */
          }
        }
        return { filePath: outputPath, skipped: false, reason: decision.reason, info: info };
      });
    });

    promise.cancel = function () {
      cancelled = true;
      if (running) {
        running.cancel();
      }
    };
    return promise;
  }

  window.ZoinkConform = {
    conform: conform,
    inspect: inspect,
    needsConform: needsConform,
    buildArgs: buildArgs,
    snapToStandardRate: snapToStandardRate
  };
})();
