/* global window, CSInterface */
/**
 * Panel-to-ExtendScript bridge.
 *
 * evalScript takes one string, so every payload is JSON-encoded and then
 * percent-encoded. That second step is not decoration: video titles carry quotes
 * and apostrophes, and Windows paths carry backslashes, all of which break a naive
 * string-concatenated call.
 */
(function () {
  "use strict";

  var csInterface = new CSInterface();

  function call(functionName, payload) {
    var encoded = encodeURIComponent(JSON.stringify(payload || {}));
    var script = "ZOINK." + functionName + '("' + encoded + '")';

    return new Promise(function (resolve) {
      csInterface.evalScript(script, function (raw) {
        resolve(parseReply(raw, functionName));
      });
    });
  }

  function parseReply(raw, functionName) {
    if (raw === "EvalScript error.") {
      return {
        ok: false,
        message:
          "Premiere rejected the " +
          functionName +
          " call. The host script may have failed to load."
      };
    }
    if (raw === undefined || raw === null || raw === "undefined" || raw === "") {
      return {
        ok: false,
        message: "Premiere returned nothing from " + functionName + "."
      };
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      return { ok: false, message: String(raw) };
    }
  }

  window.ZoinkHost = {
    csInterface: csInterface,
    call: call,
    ping: function () {
      return call("ping");
    },
    getContext: function () {
      return call("getContext");
    },
    place: function (payload) {
      return call("place", payload);
    }
  };
})();
