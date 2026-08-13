/**
 * Minimal JSON polyfill for ExtendScript (ES3), which ships without a JSON object.
 * Only stringify/parse of plain data are needed by ZOINK, so this is deliberately
 * smaller than the full json2.js. Defines JSON only when it is missing.
 */
if (typeof JSON === "undefined") {
    JSON = {};
}

(function () {
    var ESCAPES = {
        "\b": "\\b",
        "\t": "\\t",
        "\n": "\\n",
        "\f": "\\f",
        "\r": "\\r",
        '"': '\\"',
        "\\": "\\\\"
    };

    function quote(str) {
        var out = '"';
        for (var i = 0; i < str.length; i++) {
            var ch = str.charAt(i);
            var esc = ESCAPES[ch];
            if (esc) {
                out += esc;
            } else if (ch < " ") {
                var code = ch.charCodeAt(0).toString(16);
                while (code.length < 4) {
                    code = "0" + code;
                }
                out += "\\u" + code;
            } else {
                out += ch;
            }
        }
        return out + '"';
    }

    function stringifyValue(value) {
        if (value === null || value === undefined) {
            return "null";
        }
        var type = typeof value;
        if (type === "number") {
            return isFinite(value) ? String(value) : "null";
        }
        if (type === "boolean") {
            return String(value);
        }
        if (type === "string") {
            return quote(value);
        }
        if (value instanceof Array) {
            var parts = [];
            for (var i = 0; i < value.length; i++) {
                parts.push(stringifyValue(value[i]));
            }
            return "[" + parts.join(",") + "]";
        }
        if (type === "object") {
            var pairs = [];
            for (var key in value) {
                if (value.hasOwnProperty(key)) {
                    var member = value[key];
                    if (typeof member === "function" || member === undefined) {
                        continue;
                    }
                    pairs.push(quote(String(key)) + ":" + stringifyValue(member));
                }
            }
            return "{" + pairs.join(",") + "}";
        }
        return "null";
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (value) {
            return stringifyValue(value);
        };
    }

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            var source = String(text);
            // Same validity screen json2.js uses before handing the text to eval:
            // reject anything that is not a bare JSON value.
            var probe = source
                .replace(/\\["\\\/bfnrtu]/g, "@")
                .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
                .replace(/(?:^|:|,)(?:\s*\[)+/g, "");
            if (!/^[\],:{}\s]*$/.test(probe)) {
                throw new SyntaxError("Invalid JSON: " + source);
            }
            return eval("(" + source + ")");
        };
    }
})();
