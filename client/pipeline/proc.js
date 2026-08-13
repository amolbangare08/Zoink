/* global window */
/**
 * Thin wrapper around child_process for the panel context.
 *
 * Everything ZOINK does externally goes through here so that cancellation,
 * line-buffered output and Windows/macOS differences live in exactly one place.
 */
(function () {
  "use strict";

  var nodeRequire =
    typeof require === "function"
      ? require
      : window.cep_node && window.cep_node.require;

  if (!nodeRequire) {
    throw new Error(
      "Node.js is not available in this panel. Check that --enable-nodejs is set in CSXS/manifest.xml."
    );
  }

  var childProcess = nodeRequire("child_process");
  var os = nodeRequire("os");

  var IS_WINDOWS = os.platform() === "win32";

  /** Split a stream into complete lines, holding the trailing partial line back. */
  function lineReader(onLine) {
    var buffer = "";
    return function (chunk) {
      buffer += chunk.toString();
      var lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].length) {
          onLine(lines[i]);
        }
      }
    };
  }

  /**
   * Spawn a binary and resolve when it exits.
   *
   * Returns a promise carrying { code, stdout, stderr } and exposing .child so the
   * caller can cancel. Rejection only happens when the process could not start.
   */
  function run(command, args, options) {
    options = options || {};

    var stdoutChunks = [];
    var stderrChunks = [];
    var child;

    var promise = new Promise(function (resolve, reject) {
      try {
        child = childProcess.spawn(command, args, {
          cwd: options.cwd,
          windowsHide: true,
          env: options.env || process.env
        });
      } catch (error) {
        reject(error);
        return;
      }

      var onStdoutLine = lineReader(function (line) {
        stdoutChunks.push(line);
        if (options.onStdout) {
          options.onStdout(line);
        }
      });
      var onStderrLine = lineReader(function (line) {
        stderrChunks.push(line);
        if (options.onStderr) {
          options.onStderr(line);
        }
      });

      child.stdout.on("data", onStdoutLine);
      child.stderr.on("data", onStderrLine);

      child.on("error", reject);
      child.on("close", function (code, signal) {
        resolve({
          code: code,
          signal: signal,
          stdout: stdoutChunks.join("\n"),
          stderr: stderrChunks.join("\n")
        });
      });
    });

    promise.child = child;
    promise.cancel = function () {
      kill(child);
    };
    return promise;
  }

  /**
   * Kill a process and everything it spawned. yt-dlp shells out to ffmpeg, so
   * killing only the parent leaves an encoder running and the file locked.
   */
  function kill(child) {
    if (!child || child.killed || child.exitCode !== null) {
      return;
    }
    try {
      if (IS_WINDOWS) {
        childProcess.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true
        });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch (ignored) {
        /* the process is already gone */
      }
    }
  }

  /** Locate an executable on PATH. Resolves to null rather than throwing. */
  function which(name) {
    var finder = IS_WINDOWS ? "where" : "which";
    return run(finder, [name])
      .then(function (result) {
        if (result.code !== 0) {
          return null;
        }
        var first = result.stdout.split(/\r?\n/)[0].trim();
        return first.length ? first : null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Open the OS file browser with the given file selected. */
  function revealInFolder(filePath) {
    if (IS_WINDOWS) {
      // explorer.exe returns a non-zero exit code even on success, so ignore it.
      return run("explorer", ["/select,", filePath.replace(/\//g, "\\")]).catch(
        function () {}
      );
    }
    if (os.platform() === "darwin") {
      return run("open", ["-R", filePath]).catch(function () {});
    }
    return run("xdg-open", [filePath]).catch(function () {});
  }

  window.ZoinkProc = {
    run: run,
    kill: kill,
    which: which,
    revealInFolder: revealInFolder,
    require: nodeRequire,
    isWindows: IS_WINDOWS
  };
})();
