/**
 * Project/timeline operations for ZOINK.
 *
 * Everything here runs in Premiere's ExtendScript (ES3) host context: no let/const,
 * no arrow functions, no Array.prototype.find, no JSON unless json2.jsx loaded first.
 */
var ZoinkPlacement = (function () {
    var PROJECT_ITEM_TYPE_BIN = 2;

    /** Normalise a media path for comparison: Premiere hands back mixed separators. */
    function normalisePath(path) {
        if (!path) {
            return "";
        }
        return String(path).replace(/\\/g, "/").toLowerCase();
    }

    function findBin(parent, name) {
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            var isBin = false;
            try {
                isBin = child.type === PROJECT_ITEM_TYPE_BIN;
            } catch (e) {
                isBin = false;
            }
            if (isBin && String(child.name) === String(name)) {
                return child;
            }
        }
        return null;
    }

    function ensureBin(name) {
        var root = app.project.rootItem;
        if (!name) {
            return root;
        }
        var existing = findBin(root, name);
        if (existing) {
            return existing;
        }
        root.createBin(name);
        var created = findBin(root, name);
        return created ? created : root;
    }

    /** Depth-first search for the project item backed by a given file. */
    function findItemByPath(parent, targetPath) {
        var wanted = normalisePath(targetPath);
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            var mediaPath = "";
            try {
                mediaPath = child.getMediaPath();
            } catch (e) {
                mediaPath = "";
            }
            if (mediaPath && normalisePath(mediaPath) === wanted) {
                return child;
            }
            var isBin = false;
            try {
                isBin = child.type === PROJECT_ITEM_TYPE_BIN;
            } catch (e2) {
                isBin = false;
            }
            if (isBin) {
                var nested = findItemByPath(child, targetPath);
                if (nested) {
                    return nested;
                }
            }
        }
        return null;
    }

    function firstTargetedTrack(trackCollection) {
        for (var i = 0; i < trackCollection.numTracks; i++) {
            var track = trackCollection[i];
            var targeted = false;
            try {
                targeted = track.isTargeted();
            } catch (e) {
                targeted = false;
            }
            if (targeted && !isLocked(track)) {
                return track;
            }
        }
        for (var j = 0; j < trackCollection.numTracks; j++) {
            if (!isLocked(trackCollection[j])) {
                return trackCollection[j];
            }
        }
        return trackCollection.numTracks > 0 ? trackCollection[0] : null;
    }

    function isLocked(track) {
        try {
            return track.isLocked();
        } catch (e) {
            return false;
        }
    }

    function trackEndSeconds(track) {
        var end = 0;
        for (var i = 0; i < track.clips.numItems; i++) {
            var clipEnd = track.clips[i].end.seconds;
            if (clipEnd > end) {
                end = clipEnd;
            }
        }
        return end;
    }

    /**
     * overwriteClip/insertClip take a time argument whose accepted form has shifted
     * across Premiere versions (seconds as Number, seconds as String, or a Time
     * object). Try each until one sticks rather than guessing per version.
     */
    function placeClip(track, projectItem, seconds, useInsert) {
        var attempts = [];
        attempts.push(seconds);
        attempts.push(String(seconds));
        var timeObject = new Time();
        timeObject.seconds = seconds;
        attempts.push(timeObject);

        var lastError = null;
        for (var i = 0; i < attempts.length; i++) {
            try {
                if (useInsert) {
                    track.insertClip(projectItem, attempts[i]);
                } else {
                    track.overwriteClip(projectItem, attempts[i]);
                }
                return true;
            } catch (e) {
                lastError = e;
            }
        }
        throw new Error("Could not place clip on the timeline: " + (lastError ? lastError.toString() : "unknown"));
    }

    /** Best-effort source tagging. Never allowed to fail the whole placement. */
    function tagSource(projectItem, sourceUrl, note) {
        try {
            if (ExternalObject.AdobeXMPScript === undefined) {
                ExternalObject.AdobeXMPScript = new ExternalObject("lib:AdobeXMPScript");
            }
            var namespace = "http://ns.adobe.com/premierePrivateProjectMetaData/1.0/";
            var xmp = new XMPMeta(projectItem.getProjectMetadata());
            xmp.setProperty(namespace, "Column.Intrinsic.Comment", sourceUrl);
            xmp.setProperty(namespace, "Column.Intrinsic.LogNote", note);
            projectItem.setProjectMetadata(xmp.serialize(), ["Column.Intrinsic.Comment", "Column.Intrinsic.LogNote"]);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Highlight the item in the Project panel so the user can see what just
     * arrived without hunting for it.
     *
     * ProjectItem.select() is the documented route on modern builds; the others
     * are here because this API has shifted across versions and a failure to
     * highlight must never fail the import. Returns the method that worked, or
     * null if none did.
     */
    function selectInProject(projectItem) {
        if (!projectItem) {
            return null;
        }

        try {
            if (typeof projectItem.select === "function") {
                projectItem.select();
                return "select";
            }
        } catch (e) {}

        try {
            if (typeof projectItem.setSelected === "function") {
                // Second argument deselects everything else, so the new clip is
                // the only thing highlighted.
                projectItem.setSelected(true, true);
                return "setSelected";
            }
        } catch (e2) {}

        return null;
    }

    return {
        ensureBin: ensureBin,
        selectInProject: selectInProject,
        findItemByPath: findItemByPath,
        firstTargetedTrack: firstTargetedTrack,
        trackEndSeconds: trackEndSeconds,
        placeClip: placeClip,
        tagSource: tagSource,
        normalisePath: normalisePath
    };
})();
