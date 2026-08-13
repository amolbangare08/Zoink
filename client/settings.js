/* global window */
/**
 * Panel settings, persisted outside the extension folder so they survive a
 * reinstall or an update that replaces the extension directory.
 */
(function () {
  "use strict";

  var proc = window.ZoinkProc;
  var fs = proc.require("fs");
  var path = proc.require("path");
  var os = proc.require("os");

  var DEFAULTS = {
    downloadFolder: "", // empty means "next to the Premiere project"
    maxHeight: "1080",
    insertMode: "append",
    binName: "ZOINK!",
    frameAccurate: true,
    hardwareEncode: false,
    keepOriginal: false,
    useCookies: false,
    cookieBrowser: "chrome",
    proxy: "",
    ytdlpPath: "",
    ffmpegPath: "",
    ffprobePath: ""
  };

  // Where each browser keeps the profile yt-dlp reads cookies from. Order is the
  // preference order: Firefox first because it is the only one that reliably hands
  // over cookies on Windows while the browser is still running.
  var BROWSER_PROFILES = [
    { id: "firefox", label: "Firefox", win: ["APPDATA", "Mozilla/Firefox/Profiles"], mac: "Library/Application Support/Firefox/Profiles" },
    { id: "edge", label: "Edge", win: ["LOCALAPPDATA", "Microsoft/Edge/User Data"], mac: "Library/Application Support/Microsoft Edge" },
    { id: "chrome", label: "Chrome", win: ["LOCALAPPDATA", "Google/Chrome/User Data"], mac: "Library/Application Support/Google/Chrome" },
    { id: "brave", label: "Brave", win: ["LOCALAPPDATA", "BraveSoftware/Brave-Browser/User Data"], mac: "Library/Application Support/BraveSoftware/Brave-Browser" },
    { id: "vivaldi", label: "Vivaldi", win: ["LOCALAPPDATA", "Vivaldi/User Data"], mac: "Library/Application Support/Vivaldi" },
    { id: "opera", label: "Opera", win: ["APPDATA", "Opera Software/Opera Stable"], mac: "Library/Application Support/com.operasoftware.Opera" },
    { id: "safari", label: "Safari", win: null, mac: "Library/Cookies" }
  ];

  /** Which browsers actually have a profile on this machine. */
  function detectBrowsers() {
    var isWindows = os.platform() === "win32";
    var found = [];

    BROWSER_PROFILES.forEach(function (browser) {
      var location = null;
      if (isWindows && browser.win) {
        var base = process.env[browser.win[0]];
        if (base) {
          location = path.join(base, browser.win[1]);
        }
      } else if (!isWindows && browser.mac) {
        location = path.join(os.homedir(), browser.mac);
      }
      if (!location) {
        return;
      }
      try {
        if (fs.existsSync(location)) {
          found.push({ id: browser.id, label: browser.label, path: location });
        }
      } catch (error) {
        /* unreadable location counts as absent */
      }
    });

    return found;
  }

  function configDir() {
    var base =
      process.env.APPDATA ||
      (os.platform() === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(os.homedir(), ".config"));
    return path.join(base, "ZOINK");
  }

  function configFile() {
    return path.join(configDir(), "settings.json");
  }

  function load() {
    var settings = {};
    for (var key in DEFAULTS) {
      if (DEFAULTS.hasOwnProperty(key)) {
        settings[key] = DEFAULTS[key];
      }
    }
    try {
      var raw = fs.readFileSync(configFile(), "utf8");
      var stored = JSON.parse(raw);
      for (var storedKey in stored) {
        if (DEFAULTS.hasOwnProperty(storedKey)) {
          settings[storedKey] = stored[storedKey];
        }
      }
    } catch (error) {
      /* first run, or an unreadable file: defaults are fine */
    }
    return settings;
  }

  function save(settings) {
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(configFile(), JSON.stringify(settings, null, 2), "utf8");
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Where downloads land. Keeping media beside the project is what a
   * project-relative workflow expects; fall back to the user folder when the
   * project has never been saved.
   */
  function resolveDownloadFolder(settings, projectPath) {
    if (settings.downloadFolder) {
      return settings.downloadFolder;
    }
    if (projectPath) {
      try {
        return path.join(path.dirname(projectPath), "ZOINK Downloads");
      } catch (error) {
        /* fall through */
      }
    }
    return path.join(os.homedir(), "Videos", "ZOINK");
  }

  window.ZoinkSettings = {
    DEFAULTS: DEFAULTS,
    detectBrowsers: detectBrowsers,
    load: load,
    save: save,
    configFile: configFile,
    resolveDownloadFolder: resolveDownloadFolder
  };
})();
