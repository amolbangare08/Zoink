/**
 * ZOINK! — Premiere Pro host script.
 *
 * Loaded automatically via the manifest's <ScriptPath>. Every function exposed on
 * the ZOINK object is an entry point called from the panel through evalScript.
 *
 * Contract with the panel:
 *   - arguments arrive as one encodeURIComponent'd JSON string
 *   - return values are always a JSON string of { ok: Boolean, ... }
 *   - nothing may throw, because evalScript collapses host exceptions into the
 *     opaque string "EvalScript error."
 */
#include "json2.jsx"
#include "placement.jsx"

var ZOINK = (function () {
    var TICKS_PER_SECOND = 254016000000;
    var DEFAULT_BIN = "ZOINK!";

    function decodeArg(encoded) {
        if (encoded === undefined || encoded === null || encoded === "") {
            return {};
        }
        return JSON.parse(decodeURIComponent(String(encoded)));
    }

    function reply(value) {
        return JSON.stringify(value);
    }

    function fail(message, detail) {
        return reply({ ok: false, message: String(message), detail: detail ? String(detail) : "" });
    }

    /** Wrap an entry point so a thrown error becomes a structured reply. */
    function guard(fn) {
        return function (encoded) {
            try {
                return fn(decodeArg(encoded));
            } catch (e) {
                return fail(e && e.message ? e.message : String(e), e && e.line ? "line " + e.line : "");
            }
        };
    }

    function sequenceFps(sequence) {
        try {
            var timebase = parseFloat(String(sequence.timebase));
            if (timebase > 0) {
                return TICKS_PER_SECOND / timebase;
            }
        } catch (e) {}
        try {
            var frameDuration = sequence.getSettings().videoFrameRate.seconds;
            if (frameDuration > 0) {
                return 1 / frameDuration;
            }
        } catch (e2) {}
        return 0;
    }

    var api = {};

    /** Liveness probe used on panel load. */
    api.ping = guard(function () {
        return reply({
            ok: true,
            app: String(app.appName || "Premiere Pro"),
            version: String(app.version),
            hasProject: !!app.project
        });
    });

    /**
     * State the panel needs before it starts work: where the project lives (used as
     * the default download folder) and the sequence frame rate (used as the CFR
     * conform target).
     */
    api.getContext = guard(function () {
        var result = {
            ok: true,
            hasProject: false,
            projectName: "",
            projectPath: "",
            hasSequence: false,
            sequenceName: "",
            fps: 0,
            playheadSeconds: 0
        };

        if (!app.project) {
            return reply(result);
        }
        result.hasProject = true;
        result.projectName = String(app.project.name);
        try {
            result.projectPath = String(app.project.path);
        } catch (e) {}

        var sequence = app.project.activeSequence;
        if (sequence) {
            result.hasSequence = true;
            result.sequenceName = String(sequence.name);
            result.fps = sequenceFps(sequence);
            try {
                result.playheadSeconds = sequence.getPlayerPosition().seconds;
            } catch (e2) {}
        }
        return reply(result);
    });

    /**
     * Import a finished file and put it where the user asked.
     *
     * payload: {
     *   filePath, title, sourceUrl, note,
     *   insertMode: "playhead-overwrite" | "playhead-insert" | "append" | "bin-only",
     *   binName
     * }
     */
    api.place = guard(function (payload) {
        if (!app.project) {
            return fail("No Premiere project is open.");
        }
        var filePath = payload.filePath;
        if (!filePath) {
            return fail("No file path was supplied.");
        }

        var bin = ZoinkPlacement.ensureBin(payload.binName || DEFAULT_BIN);

        // importFiles returns false on a rejected import, but it also returns false
        // when the file is already in the project, so check for the item either way.
        app.project.importFiles([filePath], true, bin, false);
        var item = ZoinkPlacement.findItemByPath(app.project.rootItem, filePath);
        if (!item) {
            return fail("Premiere would not import the file.", filePath);
        }

        if (payload.sourceUrl) {
            ZoinkPlacement.tagSource(item, payload.sourceUrl, payload.note || "Imported by ZOINK!");
        }

        var mode = payload.insertMode || "playhead-overwrite";
        if (mode === "bin-only") {
            return reply({
                ok: true,
                placement: "bin-only",
                binName: String(bin.name),
                message: "Imported into the " + bin.name + " bin."
            });
        }

        var sequence = app.project.activeSequence;
        if (!sequence) {
            // Still useful: turn the grab into its own sequence rather than failing.
            try {
                app.project.createNewSequenceFromClips(String(payload.title || item.name), [item], bin);
                return reply({
                    ok: true,
                    placement: "new-sequence",
                    binName: String(bin.name),
                    message: "No sequence was open, so a new one was created from the clip."
                });
            } catch (e) {
                return reply({
                    ok: true,
                    placement: "bin-only",
                    binName: String(bin.name),
                    message: "No sequence open — the clip is waiting in the " + bin.name + " bin."
                });
            }
        }

        var track = ZoinkPlacement.firstTargetedTrack(sequence.videoTracks);
        if (!track) {
            return fail("The active sequence has no usable video track.");
        }

        var seconds;
        if (mode === "append") {
            seconds = ZoinkPlacement.trackEndSeconds(track);
        } else {
            seconds = sequence.getPlayerPosition().seconds;
        }

        ZoinkPlacement.placeClip(track, item, seconds, mode === "playhead-insert");

        return reply({
            ok: true,
            placement: mode,
            binName: String(bin.name),
            sequenceName: String(sequence.name),
            trackName: String(track.name),
            atSeconds: seconds,
            message: "Placed on " + track.name + " at " + seconds.toFixed(2) + "s."
        });
    });

    return api;
})();
