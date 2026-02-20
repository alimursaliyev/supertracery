// SuperTracery - Bridge JSX
// Entry point for all evalScript calls from CEP panel.
// Each function returns a JSON string for CEP to parse.

// ─────────────────────────────────────────────────────────────
// COMP + LAYER INFO
// ─────────────────────────────────────────────────────────────

function st_getCompInfo() {
    var result = '{"error":"No active composition"}';
    try {
        var comp = app.project.activeItem;
        if (comp && comp instanceof CompItem) {
            var selLayerName = "";
            var selLayerIndex = -1;
            if (comp.selectedLayers.length > 0) {
                selLayerName = comp.selectedLayers[0].name;
                selLayerIndex = comp.selectedLayers[0].index;
            }
            result = '{"name":' + JSON.stringify(comp.name) +
                ',"width":' + comp.width +
                ',"height":' + comp.height +
                ',"fps":' + comp.frameRate +
                ',"duration":' + comp.duration +
                ',"totalFrames":' + Math.round(comp.duration * comp.frameRate) +
                ',"pixelAspect":' + comp.pixelAspect +
                ',"currentTime":' + comp.time +
                ',"selectedLayerName":' + JSON.stringify(selLayerName) +
                ',"selectedLayerIndex":' + selLayerIndex + '}';
        }
    } catch (e) {
        result = '{"error":' + JSON.stringify(e.toString()) + '}';
    }
    return result;
}

// ─────────────────────────────────────────────────────────────
// INTERACTIVE OBJECT PICKER
// Exports current frame, opens ScriptUI image window.
// User clicks on object → returns comp-space coords.
// Blocks until click or Escape (synchronous inside AE).
// ─────────────────────────────────────────────────────────────

function st_pickPointInteractive(framePath, compWidth, compHeight) {
    var result = '{"cancelled":true}';
    try {
        var frameFile = new File(framePath);
        if (!frameFile.exists) {
            return '{"error":"Frame file not found: ' + frameFile.fsName + '"}';
        }

        // Compute display scale to fit in a reasonable window (max 900 wide)
        var maxDispW = 900;
        var maxDispH = 540;
        var scaleW = maxDispW / compWidth;
        var scaleH = maxDispH / compHeight;
        var scale = (scaleW < scaleH) ? scaleW : scaleH;
        if (scale > 1) { scale = 1; }

        var dispW = Math.round(compWidth * scale);
        var dispH = Math.round(compHeight * scale);

        // Build window
        var win = new Window("palette", "SuperTracery \u2014 Click on the object to track", undefined, {resizeable: false});
        win.margins = [8, 8, 8, 8];
        win.spacing = 6;
        win.orientation = "column";

        // Instruction bar
        var instr = win.add("statictext", undefined,
            "Click on the object  \u2022  Press Escape or close to cancel");
        instr.alignment = "center";
        instr.graphics.font = ScriptUI.newFont("Arial", "REGULAR", 12);

        // Image element — user clicks here
        var imgEl = win.add("image", [0, 0, dispW, dispH], frameFile);
        imgEl.size = [dispW, dispH];
        imgEl.alignment = ["left", "top"];

        // Crosshair overlay drawn on top (updated on mousemove)
        // We achieve this via the window's onDraw approach with a second panel
        // For simplicity, rely on cursor change + instructional text.

        var clicked = false;
        var clickX = 0;
        var clickY = 0;

        imgEl.addEventListener("mousedown", function(evt) {
            // clientX/Y are relative to the image element's top-left
            var px = evt.clientX;
            var py = evt.clientY;
            clickX = Math.round(Math.max(0, Math.min(compWidth, px / scale)));
            clickY = Math.round(Math.max(0, Math.min(compHeight, py / scale)));
            clicked = true;
            win.close();
        });

        // Scale display so cursor becomes a crosshair for clarity
        win.cursor = "crosshair";

        win.layout.layout(true);
        win.show(); // blocks until close

        if (clicked) {
            result = '{"x":' + clickX + ',"y":' + clickY + '}';
        }

    } catch (e) {
        result = '{"error":' + JSON.stringify(e.toString()) + '}';
    }
    return result;
}

// ─────────────────────────────────────────────────────────────
// QUICK SINGLE-FRAME EXPORT (for the picker preview)
// Uses saveFrameToDisk if available; falls back to render queue.
// ─────────────────────────────────────────────────────────────

function st_exportPickerFrame(outputFolder) {
    var result = '{"error":"Export failed"}';
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return '{"error":"No active composition"}';
        }

        // Always work with the OS-native filesystem path.
        // getSystemPath() on the JS side returns a file:// URL on macOS;
        // Folder(url).fsName strips it to a plain POSIX/Win path.
        var folder = new Folder(outputFolder);
        if (!folder.exists) { folder.create(); }
        var nativePath = folder.fsName;   // e.g. /Users/ali/.../temp  (no file://)

        // Wipe any leftover picker files so the post-render scan is unambiguous.
        // AE appends frame numbers AFTER the extension (e.g. picker_frame.png00000),
        // so we must glob without a .png suffix.
        var old = folder.getFiles("picker_frame*");
        var d;
        for (d = 0; d < old.length; d++) { try { old[d].remove(); } catch (ex) {} }

        var frameIdx = Math.round(comp.time * comp.frameRate);
        // Use nativePath — NOT the raw outputFolder string — for the render target
        var framePath = nativePath + "/picker_frame.png";

        // Render queue single-frame export
        var rqItem = app.project.renderQueue.items.add(comp);
        var om = rqItem.outputModule(1);

        var applied = false;
        var tmpls = om.templates;
        var i;
        for (i = 0; i < tmpls.length; i++) {
            if (tmpls[i].indexOf("PNG") >= 0) {
                try { om.applyTemplate(tmpls[i]); applied = true; break; } catch (e2) {}
            }
        }
        if (!applied) {
            try { om.applyTemplate("_HIDDEN X-Factor 8 Premul"); } catch (e3) {}
        }

        om.file = new File(framePath);
        rqItem.timeSpanStart  = comp.time;
        rqItem.timeSpanDuration = 1 / comp.frameRate;

        try {
            app.project.renderQueue.render();
        } catch (renderErr) {
            try { rqItem.remove(); } catch (re) {}
            return '{"error":"Render queue failed: ' + renderErr.toString() + '"}';
        }
        rqItem.remove();

        // AE appends the frame number AFTER the extension (e.g. picker_frame.png00000).
        // Scan the folder for anything matching our prefix.
        var outFile = new File(framePath);
        if (!outFile.exists) {
            var candidates = folder.getFiles("picker_frame*");
            if (candidates && candidates.length > 0) {
                outFile = candidates[0];
            }
        }

        if (!outFile.exists) {
            // Last-resort diagnostics: list everything in the folder
            var allFiles = folder.getFiles();
            var names = [];
            var k;
            for (k = 0; k < allFiles.length; k++) { names.push(allFiles[k].name); }
            return '{"error":"Rendered file not found. Folder: ' +
                   nativePath + ' Contents: [' + names.join(', ') + ']"}';
        }

        // Return native path (no file:// prefix) so st_pickPointInteractive
        // can pass it directly to the ScriptUI image element
        var actualPath = outFile.fsName.replace(/\\/g, "/");

        result = '{"framePath":' + JSON.stringify(actualPath) +
            ',"frameIndex":' + frameIdx +
            ',"compWidth":' + comp.width +
            ',"compHeight":' + comp.height +
            ',"fps":' + comp.frameRate +
            ',"totalFrames":' + Math.round(comp.duration * comp.frameRate) +
            ',"duration":' + comp.duration + '}';

    } catch (e) {
        result = '{"error":' + JSON.stringify(e.toString()) + '}';
    }
    return result;
}

// ─────────────────────────────────────────────────────────────
// EXPORT ALL FRAMES (for tracking)
// ─────────────────────────────────────────────────────────────

function st_exportAllFrames(outputFolder, startFrame, endFrame) {
    var result = '{"error":"Export failed"}';
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return '{"error":"No active composition"}';
        }

        var fps = comp.frameRate;
        var totalFrames = Math.round(comp.duration * fps);
        if (typeof startFrame === "undefined" || startFrame < 0) { startFrame = 0; }
        if (typeof endFrame === "undefined" || endFrame >= totalFrames) { endFrame = totalFrames - 1; }
        var numFrames = endFrame - startFrame + 1;

        // Always work with the OS-native filesystem path.
        // getSystemPath() on the JS side returns a file:// URL on macOS;
        // Folder(url).fsName strips it to a plain POSIX/Win path.
        var folder = new Folder(outputFolder);
        if (!folder.exists) { folder.create(); }
        var nativePath = folder.fsName;

        // Wipe any leftover frame files from a previous run.
        // AE appends frame numbers AFTER the extension, so glob without .png suffix.
        var old = folder.getFiles("st_frame_*");
        var d;
        for (d = 0; d < old.length; d++) { try { old[d].remove(); } catch (ex) {} }

        var rqItem = app.project.renderQueue.items.add(comp);
        var om = rqItem.outputModule(1);

        var applied = false;
        var tmpls = om.templates;
        var i;
        for (i = 0; i < tmpls.length; i++) {
            if (tmpls[i].indexOf("PNG") >= 0) {
                try { om.applyTemplate(tmpls[i]); applied = true; break; } catch (e2) {}
            }
        }
        if (!applied) {
            try { om.applyTemplate("_HIDDEN X-Factor 8 Premul"); } catch (e3) {}
        }

        var seqPath = nativePath + "/st_frame_[#####].png";
        om.file = new File(seqPath);
        rqItem.timeSpanStart = startFrame / fps;
        rqItem.timeSpanDuration = numFrames / fps;

        try {
            app.project.renderQueue.render();
        } catch (renderErr) {
            try { rqItem.remove(); } catch (re) {}
            return '{"error":"Render queue failed: ' + renderErr.toString() + '"}';
        }
        rqItem.remove();

        result = '{"framesDir":' + JSON.stringify(nativePath.replace(/\\/g, "/")) +
            ',"startFrame":' + startFrame +
            ',"endFrame":' + endFrame +
            ',"numFrames":' + numFrames +
            ',"compWidth":' + comp.width +
            ',"compHeight":' + comp.height +
            ',"fps":' + fps + '}';

    } catch (e) {
        result = '{"error":' + JSON.stringify(e.toString()) + '}';
    }
    return result;
}

// ─────────────────────────────────────────────────────────────
// GENERATE OVERLAYS
// ─────────────────────────────────────────────────────────────

function st_generateOverlays(jsonString, options) {
    var result = '{"error":"Generate failed"}';
    try {
        var data, opts;
        try {
            data = JSON.parse(jsonString);
        } catch (pe) {
            data = eval("(" + jsonString + ")");
        }
        try {
            opts = JSON.parse(options);
        } catch (pe2) {
            opts = eval("(" + options + ")");
        }
        return _st_generateOverlayObjects(data, opts);
    } catch (e) {
        return '{"error":' + JSON.stringify("Parse: " + e.toString() + " (line " + (e.line || "?") + ")") + '}';
    }
}

function _st_generateOverlayObjects(data, opts) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return '{"error":"No active composition"}';
        }

        if (!data || !data.objects || data.objects.length === 0) {
            return '{"error":"No tracking data (objects array empty or missing)"}';
        }

        app.beginUndoGroup("SuperTracery: Generate Overlays");

        var fps = comp.frameRate;
        var objects = data.objects;
        var createdLayers = [];
        var errors = [];
        var i, j, k;

        for (i = 0; i < objects.length; i++) {
            var obj = objects[i];
            var objId = obj.object_id;
            var frames = obj.frames;

            if (!frames || frames.length === 0) {
                errors.push("Object " + objId + " has no frames");
                continue;
            }

            var colorKey = String(objId);
            var color = _st_hexToArray(opts.colors[colorKey] || "#4a9eff");

            // BOUNDING BOX
            if (opts.showBBox) {
                try {
                    var bboxLayer = comp.layers.addShape();
                    bboxLayer.name = "ST_BBox_" + objId;

                    var bboxContents = bboxLayer.property("ADBE Root Vectors Group");
                    var bboxGrp = bboxContents.addProperty("ADBE Vector Group");
                    bboxGrp.name = "BBox";
                    var bboxGC = bboxGrp.property("ADBE Vectors Group");

                    // Add properties, then RE-FETCH from parent (addProperty return refs go stale in AE 2023+)
                    bboxGC.addProperty("ADBE Vector Shape - Rect");
                    bboxGC.addProperty("ADBE Vector Graphic - Stroke");
                    var bboxRect   = bboxGC.property(1); // Rectangle Path
                    var bboxStroke = bboxGC.property(2); // Stroke

                    bboxStroke.property("ADBE Vector Stroke Color").setValue(color);
                    bboxStroke.property("ADBE Vector Stroke Width").setValue(2);

                    var rectSize = bboxRect.property("ADBE Vector Rect Size");
                    var bboxPos  = bboxLayer.transform.position;

                    for (j = 0; j < frames.length; j++) {
                        var f = frames[j];
                        var t = f.frame_index / fps;
                        var bw = f.bbox[2] - f.bbox[0];
                        var bh = f.bbox[3] - f.bbox[1];
                        var bcx = f.bbox[0] + bw / 2;
                        var bcy = f.bbox[1] + bh / 2;
                        rectSize.setValueAtTime(t, [bw, bh]);
                        bboxPos.setValueAtTime(t, [bcx, bcy]);
                    }
                    createdLayers.push(bboxLayer);
                } catch (eBbox) {
                    errors.push("BBox_" + objId + ": " + eBbox.toString());
                }
            }

            // CENTER MARKER
            if (opts.showMarker) {
                try {
                    var mrkLayer = comp.layers.addShape();
                    mrkLayer.name = "ST_Marker_" + objId;

                    var mrkContents = mrkLayer.property("ADBE Root Vectors Group");
                    var mrkGrp = mrkContents.addProperty("ADBE Vector Group");
                    mrkGrp.name = "Marker";
                    var mrkGC = mrkGrp.property("ADBE Vectors Group");

                    // Add then re-fetch
                    mrkGC.addProperty("ADBE Vector Shape - Ellipse");
                    mrkGC.addProperty("ADBE Vector Graphic - Fill");
                    var mrkEllipse = mrkGC.property(1); // Ellipse Path
                    var mrkFill    = mrkGC.property(2); // Fill

                    mrkEllipse.property("ADBE Vector Ellipse Size").setValue([12, 12]);
                    mrkFill.property("ADBE Vector Fill Color").setValue(color);

                    var mrkPos = mrkLayer.transform.position;
                    for (j = 0; j < frames.length; j++) {
                        var f2 = frames[j];
                        mrkPos.setValueAtTime(f2.frame_index / fps, [f2.centroid[0], f2.centroid[1]]);
                    }
                    createdLayers.push(mrkLayer);
                } catch (eMrk) {
                    errors.push("Marker_" + objId + ": " + eMrk.toString());
                }
            }

            // LABEL
            if (opts.showLabel) {
                try {
                    var lblLayer = comp.layers.addText("Object " + objId);
                    lblLayer.name = "ST_Label_" + objId;
                    var textProp = lblLayer.property("ADBE Text Properties").property("ADBE Text Document");
                    var textDoc = textProp.value;
                    textDoc.fontSize = 14;
                    textDoc.fillColor = [color[0], color[1], color[2]];
                    textProp.setValue(textDoc);

                    var lblPos = lblLayer.property("ADBE Transform Group").property("ADBE Position");
                    for (j = 0; j < frames.length; j++) {
                        var f3 = frames[j];
                        var t3 = f3.frame_index / fps;
                        lblPos.setValueAtTime(t3, [f3.centroid[0], f3.centroid[1] - 30]);
                    }
                    createdLayers.push(lblLayer);
                } catch (eLbl) {
                    errors.push("Label_" + objId + ": " + eLbl.toString());
                }
            }

            // MOTION ARROW
            if (opts.showArrow) {
                try {
                    var arrLayer = comp.layers.addShape();
                    arrLayer.name = "ST_Arrow_" + objId;

                    var arrContents = arrLayer.property("ADBE Root Vectors Group");
                    var arrGrp = arrContents.addProperty("ADBE Vector Group");
                    arrGrp.name = "Arrow";
                    var arrGrpC = arrGrp.property("ADBE Vectors Group");

                    // Add then re-fetch
                    arrGrpC.addProperty("ADBE Vector Shape - Group");
                    arrGrpC.addProperty("ADBE Vector Graphic - Stroke");
                    var arrPath   = arrGrpC.property(1); // Path
                    var arrStroke = arrGrpC.property(2); // Stroke

                    arrStroke.property("ADBE Vector Stroke Color").setValue(color);
                    arrStroke.property("ADBE Vector Stroke Width").setValue(2);

                    var arrPathData = arrPath.property("ADBE Vector Shape");
                    var arrPos = arrLayer.transform.position;

                    for (j = 0; j < frames.length; j++) {
                        var f4 = frames[j];
                        var t4 = f4.frame_index / fps;
                        var mv = f4.motion_vector || [0, 0];
                        var mag = Math.sqrt(mv[0] * mv[0] + mv[1] * mv[1]);
                        var arrowLen = Math.max(5, Math.min(80, mag * 10));
                        var angle = Math.atan2(mv[1], mv[0]);
                        var aex = Math.cos(angle) * arrowLen;
                        var aey = Math.sin(angle) * arrowLen;
                        var headLen = Math.min(8, arrowLen * 0.3);
                        var hx1 = aex - Math.cos(angle - 0.4) * headLen;
                        var hy1 = aey - Math.sin(angle - 0.4) * headLen;
                        var hx2 = aex - Math.cos(angle + 0.4) * headLen;
                        var hy2 = aey - Math.sin(angle + 0.4) * headLen;

                        var shape4 = new Shape();
                        shape4.vertices = [[0, 0], [aex, aey], [hx1, hy1], [aex, aey], [hx2, hy2]];
                        shape4.closed = false;
                        arrPathData.setValueAtTime(t4, shape4);
                        arrPos.setValueAtTime(t4, [f4.centroid[0], f4.centroid[1]]);
                    }
                    createdLayers.push(arrLayer);
                } catch (eArr) {
                    errors.push("Arrow_" + objId + ": " + eArr.toString());
                }
            }
        }

        // CONNECTION LINES
        if (opts.showConnect && opts.connectionMode !== "none" && objects.length > 1) {
            try {
                var pairs = _st_getConnectionPairs(objects, opts.connectionMode);
                for (k = 0; k < pairs.length; k++) {
                    var pair = pairs[k];
                    var idA = pair[0];
                    var idB = pair[1];
                    var objA = null;
                    var objB = null;
                    for (var m = 0; m < objects.length; m++) {
                        if (objects[m].object_id === idA) { objA = objects[m]; }
                        if (objects[m].object_id === idB) { objB = objects[m]; }
                    }
                    if (!objA || !objB) { continue; }

                    var connLayer = comp.layers.addShape();
                    connLayer.name = "ST_Connect_" + idA + "_" + idB;

                    var connContents = connLayer.property("ADBE Root Vectors Group");
                    var connGrp = connContents.addProperty("ADBE Vector Group");
                    connGrp.name = "Line";
                    var connGrpC = connGrp.property("ADBE Vectors Group");

                    // Add then re-fetch
                    connGrpC.addProperty("ADBE Vector Shape - Group");
                    connGrpC.addProperty("ADBE Vector Graphic - Stroke");
                    var connPath   = connGrpC.property(1);
                    var connStroke = connGrpC.property(2);

                    connStroke.property("ADBE Vector Stroke Color").setValue([0.8, 0.8, 0.8, 1]);
                    connStroke.property("ADBE Vector Stroke Width").setValue(1);

                    if (opts.lineStyle === "dashed") {
                        var dashes = connStroke.property("ADBE Vector Stroke Dashes");
                        dashes.addProperty("ADBE Vector Stroke Dash 1").setValue(6);
                        dashes.addProperty("ADBE Vector Stroke Gap 1").setValue(4);
                    }

                    var connPathData = connPath.property("ADBE Vector Shape");
                    var minLen = Math.min(objA.frames.length, objB.frames.length);
                    for (j = 0; j < minLen; j++) {
                        var fa = objA.frames[j];
                        var fb = objB.frames[j];
                        var tc = fa.frame_index / fps;
                        var lineShape = new Shape();
                        lineShape.vertices = [[fa.centroid[0], fa.centroid[1]], [fb.centroid[0], fb.centroid[1]]];
                        lineShape.closed = false;
                        if (opts.lineStyle === "curved") {
                            var cdx = fb.centroid[0] - fa.centroid[0];
                            var cdy = fb.centroid[1] - fa.centroid[1];
                            var cpOff = Math.sqrt(cdx * cdx + cdy * cdy) * 0.3;
                            lineShape.outTangents = [[0, -cpOff], [0, 0]];
                            lineShape.inTangents = [[0, 0], [0, cpOff]];
                        }
                        connPathData.setValueAtTime(tc, lineShape);
                    }
                    createdLayers.push(connLayer);
                }
            } catch (eConn) {
                errors.push("Connections: " + eConn.toString());
            }
        }

        app.endUndoGroup();

        if (errors.length > 0) {
            return '{"success":true,"layersCreated":' + createdLayers.length +
                   ',"warnings":' + JSON.stringify(errors.join("; ")) + '}';
        }
        return '{"success":true,"layersCreated":' + createdLayers.length + '}';

    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return '{"error":' + JSON.stringify("Generate: " + e.toString() + " (line " + (e.line || "?") + ")") + '}';
    }
}

// ─────────────────────────────────────────────────────────────
// GENERATE OVERLAYS FROM FILES
// Reads JSON from temp files to avoid evalScript string limits.
// ─────────────────────────────────────────────────────────────

function st_generateOverlaysFromFiles(resultsPath, optionsPath) {
    try {
        var rFile = new File(resultsPath);
        if (!rFile.exists) {
            return '{"error":"Results file not found: ' + resultsPath + '"}';
        }
        rFile.encoding = "UTF-8";
        rFile.open("r");
        var jsonString = rFile.read();
        rFile.close();

        if (!jsonString || jsonString.length === 0) {
            return '{"error":"Results file is empty"}';
        }

        var oFile = new File(optionsPath);
        if (!oFile.exists) {
            return '{"error":"Options file not found: ' + optionsPath + '"}';
        }
        oFile.encoding = "UTF-8";
        oFile.open("r");
        var optionsString = oFile.read();
        oFile.close();

        // Parse JSON — use eval as fallback since ExtendScript's JSON.parse
        // can choke on larger data
        var data, opts;
        try {
            data = JSON.parse(jsonString);
        } catch (pe) {
            data = eval("(" + jsonString + ")");
        }
        try {
            opts = JSON.parse(optionsString);
        } catch (pe2) {
            opts = eval("(" + optionsString + ")");
        }

        return _st_generateOverlayObjects(data, opts);
    } catch (e) {
        return '{"error":' + JSON.stringify("FromFiles: " + e.toString() + " (line " + (e.line || "?") + ")") + '}';
    }
}

// ─────────────────────────────────────────────────────────────
// CLEAR OVERLAYS
// ─────────────────────────────────────────────────────────────

function st_clearOverlays() {
    var result = '{"error":"Clear failed"}';
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return '{"error":"No active composition"}';
        }
        app.beginUndoGroup("SuperTracery: Clear Overlays");
        var removed = 0;
        var i;
        for (i = comp.numLayers; i >= 1; i--) {
            var layer = comp.layer(i);
            if (layer.name.indexOf("ST_") === 0 || layer.name.indexOf("SuperTracery") === 0) {
                layer.remove();
                removed++;
            }
        }
        app.endUndoGroup();
        result = '{"success":true,"removed":' + removed + '}';
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        result = '{"error":' + JSON.stringify(e.toString()) + '}';
    }
    return result;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function _st_hexToArray(hex) {
    hex = hex.replace("#", "");
    var r = parseInt(hex.substring(0, 2), 16) / 255;
    var g = parseInt(hex.substring(2, 4), 16) / 255;
    var b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b, 1];
}

function _st_getConnectionPairs(objects, mode) {
    var pairs = [];
    var n = objects.length;
    var i, j;

    if (mode === "sequential") {
        for (i = 0; i < n - 1; i++) {
            pairs.push([objects[i].object_id, objects[i + 1].object_id]);
        }
    } else if (mode === "star") {
        var center = objects[0].object_id;
        for (i = 1; i < n; i++) { pairs.push([center, objects[i].object_id]); }
    } else if (mode === "full") {
        for (i = 0; i < n; i++) {
            for (j = i + 1; j < n; j++) {
                pairs.push([objects[i].object_id, objects[j].object_id]);
            }
        }
    } else if (mode === "mst") {
        var dists = [];
        for (i = 0; i < n; i++) {
            dists[i] = [];
            for (j = 0; j < n; j++) {
                if (i === j) { dists[i][j] = 0; continue; }
                var ca = objects[i].frames[0].centroid;
                var cb = objects[j].frames[0].centroid;
                var dx = ca[0] - cb[0];
                var dy = ca[1] - cb[1];
                dists[i][j] = Math.sqrt(dx * dx + dy * dy);
            }
        }
        var inMST = [];
        for (i = 0; i < n; i++) { inMST.push(i === 0); }
        for (var count = 0; count < n - 1; count++) {
            var minDist = Infinity;
            var minI = -1;
            var minJ = -1;
            for (i = 0; i < n; i++) {
                if (!inMST[i]) { continue; }
                for (j = 0; j < n; j++) {
                    if (inMST[j]) { continue; }
                    if (dists[i][j] < minDist) {
                        minDist = dists[i][j]; minI = i; minJ = j;
                    }
                }
            }
            if (minI >= 0 && minJ >= 0) {
                inMST[minJ] = true;
                pairs.push([objects[minI].object_id, objects[minJ].object_id]);
            }
        }
    }
    return pairs;
}
