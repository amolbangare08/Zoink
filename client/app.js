/* global window, document, CSInterface, SystemPath */
/**
 * ZOINK! panel controller.
 *
 * Owns the UI state machine and drives the three-step pipeline:
 *   FETCH (yt-dlp) -> ENCODE (ffmpeg) -> TIMELINE (ExtendScript).
 */
(function () {
  "use strict";

  var proc = window.ZoinkProc;
  var tools = window.ZoinkTools;
  var probeModule = window.ZoinkProbe;
  var downloadModule = window.ZoinkDownload;
  var conformModule = window.ZoinkConform;
  var settingsModule = window.ZoinkSettings;
  var errorsModule = window.ZoinkErrors;
  var host = window.ZoinkHost;
  var log = window.ZoinkLog;
  var timecode = window.ZoinkTime;

  var fs = proc.require("fs");
  var path = proc.require("path");

  // How much of the single progress rail each step owns.
  var WEIGHTS = { fetch: 0.6, encode: 0.3, timeline: 0.1 };

  var ui = {};
  var settings = settingsModule.DEFAULTS;
  var hostContext = { hasProject: false, projectPath: "", hasSequence: false, fps: 0 };
  var nvencAvailable = false;

  var job = null; // { cancel: Function } while a run is in flight
  var lastOutputPath = null;
  var lastFolder = null;
  var probeTimer = null;
  var probeToken = 0;
  var lastContextSummary = null;

  /* ------------------------------------------------------------------ boot */

  function boot() {
    cacheElements();
    log.attach(ui.console);
    injectLogo();

    settings = settingsModule.load();
    populateBrowsers();
    applySettingsToForm();
    wireEvents();

    log.muted("ZOINK! starting…");

    tools
      .detect(settings)
      .then(function (report) {
        reportTools(report);
        return tools.hasNvenc();
      })
      .then(function (hasNvenc) {
        nvencAvailable = hasNvenc;
        updateNvencHint();
        return host.ping();
      })
      .then(function (ping) {
        if (!ping.ok) {
          log.error(ping.message);
          setStatus("host error", "error");
          return;
        }
        log.muted("Connected to " + ping.app + " " + ping.version + ".");
        return refreshHostContext();
      })
      .catch(function (error) {
        log.error(String((error && error.message) || error));
        setStatus("error", "error");
      });
  }

  function cacheElements() {
    ui.viewMain = document.getElementById("view-main");
    ui.viewSettings = document.getElementById("view-settings");
    ui.logoSlot = document.getElementById("logo-slot");
    ui.statusPill = document.getElementById("status-pill");
    ui.headline = document.getElementById("headline");
    ui.rail = document.querySelector(".rail");
    ui.railFill = document.getElementById("rail-fill");
    ui.console = document.getElementById("console");
    ui.preview = document.getElementById("preview");
    ui.previewThumb = document.getElementById("preview-thumb");
    ui.previewTitle = document.getElementById("preview-title");
    ui.previewBy = document.getElementById("preview-by");
    ui.previewChips = document.getElementById("preview-chips");

    ui.url = document.getElementById("input-url");
    ui.inPoint = document.getElementById("input-in");
    ui.outPoint = document.getElementById("input-out");
    ui.quality = document.getElementById("input-quality");
    ui.insert = document.getElementById("input-insert");
    ui.zoink = document.getElementById("btn-zoink");
    ui.folder = document.getElementById("btn-folder");
    ui.settingsButton = document.getElementById("btn-settings");
    ui.closeSettings = document.getElementById("btn-close-settings");

    ui.setFolder = document.getElementById("set-folder");
    ui.setBin = document.getElementById("set-bin");
    ui.setFrameAccurate = document.getElementById("set-frame-accurate");
    ui.setHardware = document.getElementById("set-hardware");
    ui.setKeepOriginal = document.getElementById("set-keep-original");
    ui.setCookies = document.getElementById("set-cookies");
    ui.setCookieBrowser = document.getElementById("set-cookie-browser");
    ui.setProxy = document.getElementById("set-proxy");
    ui.browse = document.getElementById("btn-browse");
    ui.update = document.getElementById("btn-update");
    ui.copyLog = document.getElementById("btn-copy-log");
    ui.toolList = document.getElementById("tool-list");
    ui.hintFolder = document.getElementById("hint-folder");
    ui.hintNvenc = document.getElementById("hint-nvenc");
    ui.settingsPath = document.getElementById("settings-path");

    ui.steps = {};
    var nodes = document.querySelectorAll(".step");
    for (var i = 0; i < nodes.length; i++) {
      ui.steps[nodes[i].getAttribute("data-step")] = nodes[i];
    }
  }

  function injectLogo() {
    try {
      var svgPath = path.join(tools.extensionRoot(), "assets", "zoink-logo.svg");
      ui.logoSlot.innerHTML = fs.readFileSync(svgPath, "utf8");
    } catch (error) {
      ui.logoSlot.textContent = "";
    }
  }

  /* ---------------------------------------------------------------- status */

  function setStatus(text, state) {
    ui.statusPill.textContent = text;
    if (state) {
      ui.statusPill.setAttribute("data-state", state);
    } else {
      ui.statusPill.removeAttribute("data-state");
    }
  }

  function setHeadline(text, tone) {
    ui.headline.textContent = text;
    if (tone) {
      ui.headline.setAttribute("data-tone", tone);
    } else {
      ui.headline.removeAttribute("data-tone");
    }
  }

  function setStep(name, state) {
    var node = ui.steps[name];
    if (!node) {
      return;
    }
    if (state) {
      node.setAttribute("data-state", state);
    } else {
      node.removeAttribute("data-state");
    }
  }

  function resetSteps() {
    setStep("fetch", null);
    setStep("encode", null);
    setStep("timeline", null);
    setProgress(0);
    ui.rail.classList.remove("indeterminate");
  }

  function setProgress(fraction) {
    var clamped = Math.max(0, Math.min(1, fraction || 0));
    ui.railFill.style.width = (clamped * 100).toFixed(1) + "%";
  }

  /** Map a step-local 0..1 into the single continuous rail. */
  function stepProgress(step, fraction) {
    var base = 0;
    if (step === "encode") {
      base = WEIGHTS.fetch;
    } else if (step === "timeline") {
      base = WEIGHTS.fetch + WEIGHTS.encode;
    }
    setProgress(base + WEIGHTS[step] * Math.max(0, Math.min(1, fraction)));
  }

  function reportTools(report) {
    log.muted("Extension root: " + report.extensionRoot);
    ui.toolList.innerHTML = "";

    ["yt-dlp", "ffmpeg", "ffprobe"].forEach(function (name) {
      var row = document.createElement("div");
      row.className = "tool-row";
      row.setAttribute("data-missing", report.paths[name] ? "false" : "true");
      var label = document.createElement("b");
      label.textContent = name;
      var value = document.createElement("span");
      value.textContent = report.paths[name]
        ? (report.versions[name] || "found") + " · " + report.sources[name]
        : "not found";
      row.appendChild(label);
      row.appendChild(value);
      ui.toolList.appendChild(row);
    });

    if (report.missing.length) {
      setStatus("tools missing", "warn");
      log.error("Missing: " + report.missing.join(", "));
      log.warn(
        "Install with:  winget install yt-dlp.yt-dlp    winget install Gyan.FFmpeg"
      );
      log.warn(
        "Or drop the executables into " + report.binDir + " and reopen the panel."
      );
      setHeadline("Install the missing tools to start.", "error");
      ui.zoink.disabled = true;
      return;
    }

    setStatus("ready", null);
    log.muted(
      "Tools are used from bin/ when present, otherwise from PATH."
    );

    var age = tools.ytdlpAgeDays();
    if (age !== null && age > 60) {
      log.warn(
        "yt-dlp is " + age + " days old. Extractors break often — consider updating in Settings."
      );
    }
  }

  function updateNvencHint() {
    if (!ui.hintNvenc) {
      return;
    }
    ui.hintNvenc.textContent = nvencAvailable
      ? "Much faster conforming on an NVIDIA GPU."
      : "No h264_nvenc encoder in this ffmpeg build — this will stay off.";
    ui.setHardware.disabled = !nvencAvailable;
  }

  function refreshHostContext() {
    return host.getContext().then(function (context) {
      if (!context.ok) {
        log.warn(context.message || "Could not read the Premiere project.");
        return;
      }
      hostContext = context;
      updateFolderHint();

      // ApplicationActivate fires on every panel focus, so only speak up when the
      // project or sequence actually changed.
      var summary = context.hasProject
        ? "Project: " +
          context.projectName +
          (context.hasSequence
            ? " · sequence " +
              context.sequenceName +
              " @ " +
              context.fps.toFixed(3) +
              "fps"
            : " · no sequence open")
        : "No project is open in Premiere.";

      if (summary === lastContextSummary) {
        return;
      }
      lastContextSummary = summary;

      if (context.hasProject) {
        log.muted(summary);
      } else {
        log.warn(summary);
      }
    });
  }

  function updateFolderHint() {
    if (!ui.hintFolder) {
      return;
    }
    ui.hintFolder.textContent =
      "Currently: " +
      settingsModule.resolveDownloadFolder(settings, hostContext.projectPath);
  }

  /* -------------------------------------------------------------- settings */

  /**
   * Offer only browsers that exist on this machine. Pointing the cookie setting at
   * an uninstalled browser fails with a confusing "cookies database not found",
   * so the list is built from what is actually on disk.
   */
  function populateBrowsers() {
    var installed = settingsModule.detectBrowsers();
    ui.setCookieBrowser.innerHTML = "";

    if (!installed.length) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "No supported browser found";
      ui.setCookieBrowser.appendChild(empty);
      ui.setCookieBrowser.disabled = true;
      ui.setCookies.disabled = true;
      return;
    }

    installed.forEach(function (browser) {
      var option = document.createElement("option");
      option.value = browser.id;
      option.textContent = browser.label;
      ui.setCookieBrowser.appendChild(option);
    });

    var stillInstalled = installed.some(function (browser) {
      return browser.id === settings.cookieBrowser;
    });
    if (!stillInstalled) {
      settings.cookieBrowser = installed[0].id;
      settingsModule.save(settings);
    }
  }

  function applySettingsToForm() {
    ui.quality.value = settings.maxHeight;
    ui.insert.value = settings.insertMode;
    ui.setFolder.value = settings.downloadFolder;
    ui.setBin.value = settings.binName;
    ui.setFrameAccurate.checked = !!settings.frameAccurate;
    ui.setHardware.checked = !!settings.hardwareEncode;
    ui.setKeepOriginal.checked = !!settings.keepOriginal;
    ui.setCookies.checked = !!settings.useCookies;
    ui.setCookieBrowser.value = settings.cookieBrowser;
    ui.setProxy.value = settings.proxy;
    ui.settingsPath.textContent = settingsModule.configFile();
  }

  function readSettingsFromForm() {
    settings.maxHeight = ui.quality.value;
    settings.insertMode = ui.insert.value;
    settings.downloadFolder = ui.setFolder.value.trim();
    settings.binName = ui.setBin.value.trim() || "ZOINK!";
    settings.frameAccurate = ui.setFrameAccurate.checked;
    settings.hardwareEncode = ui.setHardware.checked && nvencAvailable;
    settings.keepOriginal = ui.setKeepOriginal.checked;
    settings.useCookies = ui.setCookies.checked;
    settings.cookieBrowser = ui.setCookieBrowser.value;
    settings.proxy = ui.setProxy.value.trim();
    settingsModule.save(settings);
    updateFolderHint();
  }

  function showSettings(show) {
    ui.viewMain.hidden = show;
    ui.viewSettings.hidden = !show;
    if (show) {
      updateFolderHint();
    }
  }

  /* ---------------------------------------------------------------- events */

  function wireEvents() {
    ui.zoink.addEventListener("click", function () {
      if (job) {
        cancelJob();
      } else {
        startJob();
      }
    });

    ui.folder.addEventListener("click", openFolder);
    ui.settingsButton.addEventListener("click", function () {
      showSettings(true);
    });
    ui.closeSettings.addEventListener("click", function () {
      readSettingsFromForm();
      showSettings(false);
    });

    ui.quality.addEventListener("change", readSettingsFromForm);
    ui.insert.addEventListener("change", readSettingsFromForm);

    [
      ui.setFolder,
      ui.setBin,
      ui.setProxy,
      ui.setCookieBrowser,
      ui.setFrameAccurate,
      ui.setHardware,
      ui.setKeepOriginal,
      ui.setCookies
    ].forEach(function (element) {
      element.addEventListener("change", readSettingsFromForm);
    });

    ui.browse.addEventListener("click", browseForFolder);
    ui.update.addEventListener("click", runSelfUpdate);
    ui.copyLog.addEventListener("click", function () {
      var text = log.copyAll();
      if (window.cep && window.cep.util && window.cep.util.copyToClipboard) {
        window.cep.util.copyToClipboard(text);
      } else {
        window.navigator.clipboard.writeText(text);
      }
      log.muted("Log copied to the clipboard.");
    });

    // Tidy the in/out fields once the user is done typing rather than on every
    // keystroke — reformatting mid-entry fights the caret.
    [ui.inPoint, ui.outPoint].forEach(function (field) {
      field.addEventListener("blur", function () {
        normaliseTimeField(field);
      });
      field.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          normaliseTimeField(field);
        }
      });
      field.addEventListener("input", function () {
        field.classList.remove("invalid");
      });
    });

    ui.url.addEventListener("input", scheduleProbe);
    ui.url.addEventListener("paste", function () {
      window.setTimeout(scheduleProbe, 0);
    });
    ui.url.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !job) {
        startJob();
      }
    });

    // Premiere fires this when the user switches project or sequence.
    host.csInterface.addEventListener(
      "com.adobe.csxs.events.ApplicationActivate",
      refreshHostContext
    );
  }

  /** Preferred cookie source: Firefox first, since it works while still open. */
  function firstInstalledBrowser() {
    var installed = settingsModule.detectBrowsers();
    return installed.length ? installed[0] : null;
  }

  function cloneWithCookies(base, browserId) {
    var copy = {};
    for (var key in base) {
      if (base.hasOwnProperty(key)) {
        copy[key] = base[key];
      }
    }
    copy.useCookies = true;
    copy.cookieBrowser = browserId;
    return copy;
  }

  /** "15" becomes "0:15", "500" becomes "8:20", "1:23:45" is left alone. */
  function normaliseTimeField(field) {
    var raw = field.value.trim();
    if (!raw.length) {
      field.value = "";
      field.classList.remove("invalid");
      return;
    }
    var seconds = timecode.parse(raw);
    if (seconds === null) {
      field.classList.add("invalid");
      return;
    }
    field.classList.remove("invalid");
    field.value = timecode.display(seconds);
  }

  function browseForFolder() {
    if (!window.cep || !window.cep.fs) {
      log.warn("Folder picker is unavailable; type the path instead.");
      return;
    }
    var result = window.cep.fs.showOpenDialogEx(
      false,
      true,
      "Choose the ZOINK download folder",
      ui.setFolder.value || undefined
    );
    if (result && result.data && result.data.length) {
      ui.setFolder.value = result.data[0];
      readSettingsFromForm();
    }
  }

  function runSelfUpdate() {
    ui.update.disabled = true;
    log.info("Checking for yt-dlp updates…");
    tools
      .selfUpdate(function (line) {
        log.muted(line);
      })
      .then(function () {
        return tools.detect(settings);
      })
      .then(function (report) {
        reportTools(report);
        log.good("yt-dlp update check finished.");
      })
      .catch(function (error) {
        log.error(String((error && error.message) || error));
      })
      .then(function () {
        ui.update.disabled = false;
      });
  }

  /* ----------------------------------------------------------------- probe */

  function scheduleProbe() {
    window.clearTimeout(probeTimer);
    var url = ui.url.value.trim();
    if (!url.length) {
      setHeadline("Paste a link to begin.");
      clearPreview();
      return;
    }
    var identity = probeModule.identify(url);
    if (!identity.valid) {
      setHeadline(identity.reason, "error");
      clearPreview();
      return;
    }
    adoptStartTimeFromUrl(url);
    probeTimer = window.setTimeout(function () {
      runProbe(url, identity);
    }, 700);
  }

  /**
   * A link copied at a timestamp already says where the user wants to start, so
   * take it — but never overwrite an in point they typed themselves.
   */
  function adoptStartTimeFromUrl(url) {
    if (ui.inPoint.value.trim().length) {
      return;
    }
    var seconds = probeModule.extractStartTime(url);
    if (seconds === null || seconds <= 0) {
      return;
    }
    ui.inPoint.value = timecode.display(seconds);
    log.muted("In point " + ui.inPoint.value + " taken from the link.");
  }

  function runProbe(url, identity) {
    if (job) {
      return;
    }
    var token = ++probeToken;
    setHeadline("Reading " + identity.label + " link…");
    probeModule
      .probe(url, settings)
      .then(function (info) {
        if (token !== probeToken || job) {
          return;
        }
        describe(info, identity);
      })
      .catch(function (error) {
        if (token !== probeToken || job) {
          return;
        }
        setHeadline(error.friendly || "Could not read that link.", "error");
      });
  }

  function describe(info, identity) {
    var summary =
      info.title +
      (info.duration ? " · " + timecode.pretty(info.duration) : "") +
      (info.height ? " · " + info.height + "p" : "");
    setHeadline("Ready to zoink.", "ok");
    renderPreview(info, identity);
    log.muted("[" + identity.label + "] " + summary);
    if (info.isLive) {
      log.warn("This is a live stream — set an out point or it will not stop.");
    }
    return info;
  }

  /**
   * Show what was actually resolved before any bandwidth is spent. With in/out
   * points set, a wrong link otherwise costs a full round trip to discover.
   */
  function renderPreview(info, identity) {
    ui.previewTitle.textContent = info.title;
    ui.previewBy.textContent = info.uploader
      ? info.uploader + " · " + identity.label
      : identity.label;

    ui.previewChips.innerHTML = "";
    var chips = [];
    if (info.duration) {
      chips.push({ text: timecode.pretty(info.duration), tone: "accent" });
    }
    if (info.height) {
      chips.push({ text: info.height + "p" });
    }
    if (info.fps) {
      chips.push({ text: Math.round(info.fps) + "fps" });
    }
    if (info.filesize) {
      chips.push({ text: "~" + formatBytes(info.filesize) });
    }
    if (info.isLive) {
      chips.push({ text: "LIVE" });
    }
    chips.forEach(function (chip) {
      var node = document.createElement("span");
      node.className = "chip";
      node.textContent = chip.text;
      if (chip.tone) {
        node.setAttribute("data-tone", chip.tone);
      }
      ui.previewChips.appendChild(node);
    });

    // The thumbnail is remote, so treat it as optional decoration.
    ui.previewThumb.hidden = true;
    if (info.thumbnail) {
      ui.previewThumb.onload = function () {
        ui.previewThumb.hidden = false;
      };
      ui.previewThumb.onerror = function () {
        ui.previewThumb.hidden = true;
      };
      ui.previewThumb.src = info.thumbnail;
    }

    ui.preview.hidden = false;
  }

  function clearPreview() {
    ui.preview.hidden = true;
    ui.previewThumb.removeAttribute("src");
    ui.previewThumb.hidden = true;
  }

  /* ------------------------------------------------------------------- job */

  function setRunning(running) {
    ui.zoink.textContent = running ? "Cancel" : "Zoink to timeline";
    ui.zoink.setAttribute("data-mode", running ? "cancel" : "run");
    [ui.url, ui.inPoint, ui.outPoint, ui.quality, ui.insert].forEach(function (
      element
    ) {
      element.disabled = running;
    });
    ui.settingsButton.disabled = running;
    if (running) {
      ui.rail.classList.add("working");
    } else {
      ui.rail.classList.remove("working");
    }
    setStatus(running ? "working" : "ready", running ? "busy" : null);
  }

  function startJob() {
    var url = ui.url.value.trim();
    if (!url.length) {
      setHeadline("Paste a link first.", "error");
      return;
    }
    var identity = probeModule.identify(url);
    if (!identity.valid) {
      setHeadline(identity.reason, "error");
      return;
    }
    if (!identity.supported) {
      log.warn("Unverified site — yt-dlp will try anyway.");
    }

    readSettingsFromForm();
    resetSteps();
    setRunning(true);

    var cancelled = false;
    var active = null;
    job = {
      cancel: function () {
        cancelled = true;
        if (active && active.cancel) {
          active.cancel();
        }
      }
    };

    function guardCancel() {
      if (cancelled) {
        throw probeModule.makeError("Cancelled.", "");
      }
    }

    /**
     * Run a pipeline step, and if the site turns us away with a bot check or a
     * 403, transparently retry once with browser cookies. Without this the
     * one-click promise only holds for users who already configured cookies,
     * which on YouTube is now most videos.
     */
    function attempt(factory) {
      var first = factory(settings);
      active = first;

      return first.catch(function (error) {
        var signature =
          ((error && error.raw) || "") +
          " " +
          ((error && (error.friendly || error.message)) || "");

        var browser = settings.useCookies ? null : firstInstalledBrowser();
        // `tryCookies` is an explicit request from a step that already exhausted
        // its own fallbacks, for failures whose text does not look like an auth
        // wall but whose cause turns out to be one.
        var worthRetrying =
          errorsModule.isAuthWall(signature) || error.tryCookies === true;

        if (
          cancelled ||
          !browser ||
          /cancelled/i.test(signature) ||
          !worthRetrying
        ) {
          throw error;
        }

        log.warn(
          "Blocked by the site — retrying with " + browser.label + " cookies…"
        );

        var retrySettings = cloneWithCookies(settings, browser.id);
        var second = factory(retrySettings);
        active = second;

        return second.then(function (result) {
          // It worked, so make it stick rather than asking again next time.
          settings.useCookies = true;
          settings.cookieBrowser = browser.id;
          settingsModule.save(settings);
          applySettingsToForm();
          log.good(
            "Cookies got through — browser cookies are now on in Settings (" +
              browser.label +
              ")."
          );
          return result;
        });
      });
    }

    refreshHostContext()
      .then(function () {
        // ---- FETCH -------------------------------------------------------
        guardCancel();
        setStep("fetch", "active");
        ui.rail.classList.add("indeterminate");
        setHeadline("Reading the link…");

        return attempt(function (attemptSettings) {
          return probeModule.probe(url, attemptSettings, function (line) {
            log.muted(line);
          });
        });
      })
      .then(function (info) {
        guardCancel();
        ui.rail.classList.remove("indeterminate");
        describe(info, identity);

        var range = timecode.validateRange(
          ui.inPoint.value,
          ui.outPoint.value,
          info.duration
        );
        if (!range.ok) {
          throw probeModule.makeError(range.message, "");
        }
        if (range.inSeconds !== null || range.outSeconds !== null) {
          log.info(
            "Grabbing " +
              timecode.pretty(range.inSeconds || 0) +
              " → " +
              (range.outSeconds === null
                ? "end"
                : timecode.pretty(range.outSeconds)) +
              " only."
          );
        }

        var workDir = settingsModule.resolveDownloadFolder(
          settings,
          hostContext.projectPath
        );
        lastFolder = workDir;
        log.muted("Downloading to " + workDir);

        return attempt(function (attemptSettings) {
          return downloadModule.download({
            url: url,
            workDir: workDir,
            maxHeight: settings.maxHeight,
            inSeconds: range.inSeconds,
            outSeconds: range.outSeconds,
            frameAccurate: settings.frameAccurate,
            settings: attemptSettings,
            onProgress: function (fraction, detail) {
              stepProgress("fetch", fraction);
              setHeadline(
                "Fetching — " +
                  Math.round(fraction * 100) +
                  "%" +
                  (detail.speed
                    ? " · " + formatBytes(detail.speed) + "/s"
                    : "") +
                  (detail.eta
                    ? " · " + timecode.pretty(detail.eta) + " left"
                    : "")
              );
            },
            onLog: function (line) {
              log.muted(line);
            }
          });
        });
      })
      .then(function (result) {
        // ---- ENCODE ------------------------------------------------------
        guardCancel();
        setStep("fetch", "done");
        lastOutputPath = result.filePath;
        log.good("Downloaded " + path.basename(result.filePath));

        setStep("encode", "active");
        setHeadline("Making it edit-safe…");

        active = conformModule.conform({
          inputPath: result.filePath,
          targetFps: hostContext.fps || 0,
          useNvenc: settings.hardwareEncode && nvencAvailable,
          keepOriginal: settings.keepOriginal,
          onProgress: function (fraction) {
            stepProgress("encode", fraction);
            setHeadline("Encoding — " + Math.round(fraction * 100) + "%");
          },
          onLog: function (line) {
            log.muted(line);
          }
        });
        return active;
      })
      .then(function (result) {
        // ---- TIMELINE ----------------------------------------------------
        guardCancel();
        setStep("encode", "done");
        lastOutputPath = result.filePath;
        log.good(
          result.skipped
            ? "No encode needed — " + result.reason + "."
            : "Conformed to edit-safe H.264."
        );

        setStep("timeline", "active");
        stepProgress("timeline", 0.2);
        setHeadline("Handing it to Premiere…");

        active = null;
        return host.place({
          filePath: result.filePath,
          title: path.basename(result.filePath, path.extname(result.filePath)),
          sourceUrl: url,
          note: "ZOINK! from " + identity.label,
          insertMode: settings.insertMode,
          binName: settings.binName
        });
      })
      .then(function (placement) {
        if (!placement.ok) {
          throw probeModule.makeError(placement.message, placement.detail || "");
        }
        setStep("timeline", "done");
        setProgress(1);
        log.good(placement.message);

        if (placement.selected) {
          log.muted("Highlighted in the " + placement.binName + " bin.");
        } else {
          // Not fatal, but worth saying — otherwise a silently missing highlight
          // looks like the clip failed to import.
          log.warn(
            "Could not highlight the clip — find it in the " +
              placement.binName +
              " bin."
          );
        }
        setHeadline("Zoinked. " + placement.message, "ok");
        finishJob();
      })
      .catch(function (error) {
        handleFailure(error, cancelled);
      });
  }

  function handleFailure(error, cancelled) {
    var message = (error && (error.friendly || error.message)) || String(error);
    ui.rail.classList.remove("indeterminate");

    ["fetch", "encode", "timeline"].forEach(function (name) {
      if (ui.steps[name].getAttribute("data-state") === "active") {
        setStep(name, cancelled ? null : "error");
      }
    });

    if (cancelled || /cancelled/i.test(message)) {
      setHeadline("Cancelled.");
      log.warn("Cancelled by user.");
      setProgress(0);
    } else {
      setHeadline(message, "error");
      log.error(message);
      if (error && error.raw) {
        log.muted(error.raw);
      }
    }
    finishJob();
  }

  function finishJob() {
    job = null;
    setRunning(false);
  }

  function cancelJob() {
    if (!job) {
      return;
    }
    log.warn("Cancelling…");
    job.cancel();
  }

  /* --------------------------------------------------------------- utility */

  function openFolder() {
    var target =
      lastOutputPath ||
      lastFolder ||
      settingsModule.resolveDownloadFolder(settings, hostContext.projectPath);
    try {
      if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
      }
    } catch (error) {
      log.error("Could not open " + target);
      return;
    }
    proc.revealInFolder(target);
  }

  function formatBytes(bytes) {
    var units = ["B", "KB", "MB", "GB"];
    var value = Number(bytes) || 0;
    var index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index++;
    }
    return value.toFixed(value >= 10 || index === 0 ? 0 : 1) + units[index];
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
