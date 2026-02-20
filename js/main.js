/* SuperTracery — main.js
 * Full end-to-end wiring: pick points → export frames → Python tracking → generate overlays.
 * CEP panels have access to Node.js (require), so we use child_process for Python subprocess.
 */

(function () {
    "use strict";

    /* ── Node.js modules (available in CEP with --enable-nodejs) ─ */
    var _require = (typeof cep_node !== "undefined" && cep_node.require)
                 ? cep_node.require                                      // CEP 9+ namespace
                 : (typeof require === "function" ? require : null);     // direct Node.js require

    var childProcess = null, fs = null;
    if (_require) {
        try {
            childProcess = _require("child_process");
            fs           = _require("fs");
        } catch (e) {
            childProcess = null;
            fs           = null;
        }
    }

    /* ── State ─────────────────────────────────────────────── */
    var objects          = [];
    var nextId           = 0;
    var toggles          = { bbox: true, marker: true, label: true,
                             arrow: false, mask: false, connect: false };
    var connMode         = "none";
    var lineStyle        = "straight";
    var strokeWidth      = 2;
    var overlayOpacity   = 100;
    var maskFillOpacity  = 15;
    var objectColors     = {};      // id -> hex color override
    var comp             = null;      // info from st_getCompInfo()
    var picking          = false;     // guard against double-clicks
    var tracking         = false;     // true while Python subprocess is running
    var trackingResults  = null;      // parsed results.json after tracking
    var pythonProc       = null;      // child_process handle (for cancel)

    /* Preview server state */
    var previewProc      = null;
    var previewReady     = false;
    var previewResult    = null;
    var previewCanvas    = null;
    var previewCtx       = null;
    var previewThrottleTimer = null;
    var previewLastQuery = 0;

    /* ── CEP bridge ─────────────────────────────────────────── */
    var cs = null;
    var tempFolder = "";
    var extPath    = "";

    /* Default object colors for overlays */
    var COLORS = ["#3fb8f5", "#ff6b4a", "#4aff8f", "#ffcc33",
                  "#c850c0", "#00e5ff", "#ff4081", "#76ff03"];

    function initCS() {
        try {
            cs = new CSInterface();                                       // eslint-disable-line
            var rawExtPath = cs.getSystemPath(SystemPath.EXTENSION);     // eslint-disable-line

            // getSystemPath returns file:///... URLs on macOS — strip to native path
            extPath    = rawExtPath.replace(/^file\:\/\/\//, "/");
            tempFolder = (extPath + "/temp").replace(/\\/g, "/");

            // Force-reload the JSX bridge so edits take effect without restarting AE
            cs.evalScript('$.evalFile("' + rawExtPath + '/jsx/bridge.jsx")');
        } catch (e) {
            cs = null; // running in a plain browser — no AE
        }
    }

    function evalScript(script, cb) {
        if (!cs) { if (cb) { cb('{"error":"Not connected to After Effects"}'); } return; }
        cs.evalScript(script, cb || function () {});
    }

    /* ── DOM refs ──────────────────────────────────────────── */
    var btnPick, btnRefreshComp, btnTrack, btnGenerate, btnClear;
    var objectList, emptyState, objectCount;
    var compBar, compName, compRes, compFrame;
    var pickHint;
    var progressBlock, progressFill, progressCount, progressStdout;
    var statusText, statusCursor;
    var logArea;

    /* ── Boot ──────────────────────────────────────────────── */
    function init() {
        initCS();

        btnPick         = document.getElementById("btnAddObject");
        btnRefreshComp  = document.getElementById("btnRefreshComp");
        btnTrack        = document.getElementById("btnTrack");
        btnGenerate     = document.getElementById("btnGenerate");
        btnClear        = document.getElementById("btnClear");

        objectList      = document.getElementById("objectList");
        emptyState      = document.getElementById("emptyState");
        objectCount     = document.getElementById("objectCount");

        compBar         = document.getElementById("compBar");
        compName        = document.getElementById("compName");
        compRes         = document.getElementById("compRes");
        compFrame       = document.getElementById("compFrame");
        pickHint        = document.getElementById("pickHint");

        progressBlock   = document.getElementById("progressBlock");
        progressFill    = document.getElementById("progressFill");
        progressCount   = document.getElementById("progressCount");
        progressStdout  = document.getElementById("progressStdout");

        statusText      = document.getElementById("statusText");
        statusCursor    = document.getElementById("statusCursor");
        logArea         = document.getElementById("logArea");

        /* Events */
        btnPick.addEventListener("click", onPickPoint);
        btnRefreshComp.addEventListener("click", onRefreshComp);
        btnTrack.addEventListener("click", onTrackClick);
        btnGenerate.addEventListener("click", onGenerateOverlays);
        btnClear.addEventListener("click", onClearAll);

        /* Toggles */
        var toggleRows = document.querySelectorAll(".toggle-row");
        for (var i = 0; i < toggleRows.length; i++) {
            toggleRows[i].addEventListener("click", onToggleClick);
        }

        /* Selectors */
        var connOpts = document.querySelectorAll("#connMode .opt");
        for (var j = 0; j < connOpts.length; j++) {
            connOpts[j].addEventListener("click", onConnModeClick);
        }
        var lineOpts = document.querySelectorAll("#lineStyle .opt");
        for (var k = 0; k < lineOpts.length; k++) {
            lineOpts[k].addEventListener("click", onLineStyleClick);
        }

        /* Sliders */
        var slStroke = document.getElementById("sliderStrokeWidth");
        if (slStroke) {
            slStroke.addEventListener("input", function () {
                strokeWidth = parseInt(slStroke.value, 10);
                document.getElementById("valStrokeWidth").textContent = String(strokeWidth);
            });
        }
        var slOpacity = document.getElementById("sliderOverlayOpacity");
        if (slOpacity) {
            slOpacity.addEventListener("input", function () {
                overlayOpacity = parseInt(slOpacity.value, 10);
                document.getElementById("valOverlayOpacity").textContent = overlayOpacity + "%";
            });
        }
        var slMask = document.getElementById("sliderMaskFillOpacity");
        if (slMask) {
            slMask.addEventListener("input", function () {
                maskFillOpacity = parseInt(slMask.value, 10);
                document.getElementById("valMaskFillOpacity").textContent = maskFillOpacity + "%";
            });
        }

        setStatus("READY", "idle");
        log("panel initialized");

        /* Load comp on startup */
        loadCompInfo();
    }

    /* ── Comp info ─────────────────────────────────────────── */
    function loadCompInfo() {
        if (!cs) {
            setCompState(null);
            return;
        }

        btnRefreshComp.classList.add("spinning");

        evalScript("st_getCompInfo()", function (raw) {
            btnRefreshComp.classList.remove("spinning");
            try {
                var info = JSON.parse(raw);
                if (info.error) {
                    setCompState(null);
                    log("no active comp");
                } else {
                    comp = info;
                    setCompState(info);
                    log("comp: " + info.name + "  " + info.width + "\u00d7" + info.height);
                }
            } catch (e) {
                setCompState(null);
            }
        });
    }

    function onRefreshComp() {
        loadCompInfo();
    }

    function setCompState(info) {
        if (!info) {
            compBar.classList.add("no-comp");
            compName.textContent  = "\u2014";
            compRes.textContent   = "\u2014";
            compFrame.textContent = "\u2014";
            btnPick.disabled = true;
            pickHint.textContent = "Open a composition in After Effects first";
        } else {
            compBar.classList.remove("no-comp");
            var shortName = info.name.length > 18 ? info.name.slice(0, 16) + "\u2026" : info.name;
            compName.textContent  = shortName;
            compRes.textContent   = info.width + " \u00d7 " + info.height;
            var cur   = Math.round(info.currentTime * info.fps);
            var total = info.totalFrames;
            compFrame.textContent = pad3(cur) + " / " + pad3(total);
            btnPick.disabled = false;
            pickHint.textContent = "Opens current frame \u2014 click on the object to track";
        }
    }

    /* ── Pick point (main action) ──────────────────────────── */
    /* Uses in-panel HTML overlay instead of ScriptUI for reliable
       image scaling, click detection, and crosshair cursor. */

    var pickerOverlay, pickerImage, pickerCrosshair, pickerCoords, pickerCancel, pickerViewport;
    var pickerCompW = 0, pickerCompH = 0;
    var pickerCleanup = null;

    function onPickPoint() {
        if (picking) { return; }
        if (!cs) {
            log("error: not connected to After Effects");
            return;
        }

        picking = true;
        btnPick.disabled = true;
        setStatus("EXPORTING FRAME\u2026", "processing");
        log("exporting current frame\u2026");

        var folder = tempFolder.replace(/\\/g, "/");

        evalScript('st_exportPickerFrame("' + escJs(folder) + '")', function (raw1) {
            try {
                var data = JSON.parse(raw1);
                if (data.error) {
                    finishPick();
                    log("error: " + data.error);
                    return;
                }

                /* Update comp state from fresh data */
                comp = {
                    name: comp ? comp.name : "\u2014",
                    width: data.compWidth,
                    height: data.compHeight,
                    fps: data.fps,
                    totalFrames: data.totalFrames,
                    currentTime: 0
                };
                setCompState(comp);

                pickerCompW = data.compWidth;
                pickerCompH = data.compHeight;

                setStatus("PICK POINT\u2026", "processing");
                log("frame ready \u2014 click on the object");

                /* Show in-panel picker overlay */
                openPickerOverlay(data.framePath);

            } catch (e) {
                finishPick();
                log("error: frame export response invalid");
            }
        });
    }

    /* ── Preview server lifecycle ─────────────────────────── */
    function startPreviewServer(framePath) {
        if (!childProcess) { return; }

        previewReady  = false;
        previewResult = null;

        var pickerLoading = document.getElementById("pickerLoading");
        if (pickerLoading) { pickerLoading.style.display = "block"; }

        var pythonScript = extPath + "/python/preview_server.py";
        var venvPython   = extPath + "/python/venv/bin/python3";

        function trySpawn(cmd) {
            var proc;
            try {
                proc = childProcess.spawn(cmd, [pythonScript, framePath], {
                    cwd: extPath + "/python"
                });
            } catch (e) {
                return null;
            }
            return proc;
        }

        var proc = trySpawn(venvPython);
        if (!proc) { proc = trySpawn("python3"); }
        if (!proc) { proc = trySpawn("python"); }
        if (!proc) {
            log("preview: could not start python");
            if (pickerLoading) { pickerLoading.style.display = "none"; }
            return;
        }

        previewProc = proc;
        var stdoutBuf = "";

        proc.stdout.on("data", function (chunk) {
            stdoutBuf += chunk.toString();
            var lines = stdoutBuf.split("\n");
            stdoutBuf = lines.pop();

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line) { continue; }

                if (line === "READY") {
                    previewReady = true;
                    if (pickerLoading) { pickerLoading.style.display = "none"; }
                    log("preview: SAM2 ready");
                    continue;
                }

                if (line.indexOf("ERROR:") === 0) {
                    log("preview: " + line);
                    if (pickerLoading) { pickerLoading.style.display = "none"; }
                    continue;
                }

                if (line.indexOf("INFO:") === 0) {
                    continue; // suppress model loading messages
                }

                // Try to parse as JSON result
                try {
                    var result = JSON.parse(line);
                    if (result.error) {
                        log("preview error: " + result.error);
                    } else {
                        previewResult = result;
                        drawPreview();
                    }
                } catch (e) {
                    // Not JSON, ignore
                }
            }
        });

        proc.stderr.on("data", function () {});

        proc.on("error", function () {
            previewProc = null;
            previewReady = false;
            if (pickerLoading) { pickerLoading.style.display = "none"; }
        });

        proc.on("close", function () {
            previewProc = null;
            previewReady = false;
        });
    }

    function sendPreviewQuery(x, y) {
        if (!previewProc || !previewReady) { return; }
        var now = Date.now();
        if (now - previewLastQuery < 150) { return; }
        previewLastQuery = now;

        try {
            previewProc.stdin.write(JSON.stringify({ x: x, y: y }) + "\n");
        } catch (e) {
            // stdin closed
        }
    }

    function sizeCanvasToImage() {
        if (!previewCanvas || !pickerImage || !pickerViewport) { return; }
        var imgRect = pickerImage.getBoundingClientRect();
        var vpRect  = pickerViewport.getBoundingClientRect();
        /* Position relative to the parent (picker-viewport), not the browser window */
        previewCanvas.width  = imgRect.width;
        previewCanvas.height = imgRect.height;
        previewCanvas.style.left   = (imgRect.left - vpRect.left) + "px";
        previewCanvas.style.top    = (imgRect.top  - vpRect.top)  + "px";
        previewCanvas.style.width  = imgRect.width  + "px";
        previewCanvas.style.height = imgRect.height + "px";
    }

    function drawPreview() {
        if (!previewCanvas || !previewCtx || !previewResult) { return; }

        var canvas = previewCanvas;
        var ctx    = previewCtx;
        var img    = pickerImage;
        var rect   = img.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) { return; }

        var scaleX = rect.width  / pickerCompW;
        var scaleY = rect.height / pickerCompH;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        var poly = previewResult.polygon;
        var bbox = previewResult.bbox;

        // Draw polygon fill + stroke
        if (poly && poly.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(poly[0][0] * scaleX, poly[0][1] * scaleY);
            for (var i = 1; i < poly.length; i++) {
                ctx.lineTo(poly[i][0] * scaleX, poly[i][1] * scaleY);
            }
            ctx.closePath();
            ctx.fillStyle = "rgba(63,184,245,0.25)";
            ctx.fill();
            ctx.strokeStyle = "rgba(63,184,245,0.8)";
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // Draw bounding box (dashed)
        if (bbox) {
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = "rgba(63,184,245,0.5)";
            ctx.lineWidth = 1;
            ctx.strokeRect(
                bbox[0] * scaleX,
                bbox[1] * scaleY,
                (bbox[2] - bbox[0]) * scaleX,
                (bbox[3] - bbox[1]) * scaleY
            );
            ctx.setLineDash([]);
        }

        // Update score badge
        var scoreBadge = document.getElementById("pickerScore");
        if (scoreBadge && previewResult.score != null) {
            scoreBadge.style.display = "block";
            scoreBadge.textContent = "SCORE: " + Math.round(previewResult.score * 100) + "%";
        }
    }

    function clearPreview() {
        if (previewCtx && previewCanvas) {
            previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        }
        previewResult = null;
        var scoreBadge = document.getElementById("pickerScore");
        if (scoreBadge) { scoreBadge.style.display = "none"; }
    }

    function stopPreviewServer() {
        if (previewProc) {
            try {
                previewProc.stdin.write("QUIT\n");
            } catch (e) {}
            try {
                previewProc.kill("SIGTERM");
            } catch (e) {}
            previewProc = null;
        }
        previewReady  = false;
        previewResult = null;
        if (previewThrottleTimer) {
            clearTimeout(previewThrottleTimer);
            previewThrottleTimer = null;
        }
        clearPreview();
        var pickerLoading = document.getElementById("pickerLoading");
        if (pickerLoading) { pickerLoading.style.display = "none"; }
    }

    function openPickerOverlay(framePath) {
        pickerOverlay   = document.getElementById("pickerOverlay");
        pickerImage     = document.getElementById("pickerImage");
        pickerCrosshair = document.getElementById("pickerCrosshair");
        pickerCoords    = document.getElementById("pickerCoords");
        pickerCancel    = document.getElementById("pickerCancel");
        pickerViewport  = document.getElementById("pickerViewport");

        /* Preview canvas setup */
        previewCanvas = document.getElementById("pickerCanvas");
        previewCtx    = previewCanvas ? previewCanvas.getContext("2d") : null;

        /* Load the exported frame — CEP has file:// access via CEF flags.
           Append timestamp to bust browser cache when the file is overwritten. */
        pickerImage.src = "file://" + framePath + "?t=" + Date.now();
        pickerOverlay.classList.add("active");
        pickerCrosshair.style.display = "none";
        pickerCoords.style.display    = "none";

        /* Size canvas to match image once loaded */
        pickerImage.onload = function () {
            sizeCanvasToImage();
        };

        /* Start SAM2 preview server */
        startPreviewServer(framePath);

        /* --- Event handlers --- */
        function onImageClick(evt) {
            var rect = pickerImage.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) { return; }

            var scaleX = pickerCompW / rect.width;
            var scaleY = pickerCompH / rect.height;
            var x = Math.round((evt.clientX - rect.left) * scaleX);
            var y = Math.round((evt.clientY - rect.top) * scaleY);
            x = Math.max(0, Math.min(pickerCompW, x));
            y = Math.max(0, Math.min(pickerCompH, y));

            cleanup();

            /* Add the tracked point, enriched with preview data if available */
            var obj = { id: nextId, x: x, y: y };
            if (previewResult) {
                obj.bbox     = previewResult.bbox;
                obj.polygon  = previewResult.polygon;
                obj.centroid = previewResult.centroid;
                obj.score    = previewResult.score;
            }
            objects.push(obj);
            nextId++;
            renderObjectList();
            updateButtons();
            finishPick();
            log("point_" + pad2(obj.id) + " \u2192 (" + pad4(obj.x) + ", " + pad4(obj.y) + ")");
        }

        function onMouseMove(evt) {
            var rect = pickerImage.getBoundingClientRect();
            var vpRect = pickerViewport.getBoundingClientRect();
            var mx = evt.clientX;
            var my = evt.clientY;

            /* Only show crosshair when cursor is over the image */
            if (mx >= rect.left && mx <= rect.right && my >= rect.top && my <= rect.bottom) {
                pickerCrosshair.style.display = "block";
                pickerCrosshair.style.left = (mx - vpRect.left) + "px";
                pickerCrosshair.style.top  = (my - vpRect.top)  + "px";

                var scaleX = pickerCompW / rect.width;
                var scaleY = pickerCompH / rect.height;
                var cx = Math.round((mx - rect.left) * scaleX);
                var cy = Math.round((my - rect.top) * scaleY);
                pickerCoords.style.display = "block";
                pickerCoords.textContent = "X:" + pad4(cx) + "  Y:" + pad4(cy);

                /* Send SAM2 preview query (throttled) */
                sendPreviewQuery(cx, cy);
            } else {
                pickerCrosshair.style.display = "none";
                pickerCoords.style.display    = "none";
            }
        }

        function onCancelClick() {
            cleanup();
            finishPick();
            log("pick cancelled");
        }

        function onKeyDown(evt) {
            if (evt.key === "Escape") {
                onCancelClick();
            }
        }

        function cleanup() {
            pickerImage.removeEventListener("click", onImageClick);
            pickerViewport.removeEventListener("mousemove", onMouseMove);
            pickerCancel.removeEventListener("click", onCancelClick);
            document.removeEventListener("keydown", onKeyDown);
            pickerOverlay.classList.remove("active");
            pickerCrosshair.style.display = "none";
            pickerCoords.style.display    = "none";
            pickerCleanup = null;
            stopPreviewServer();
        }

        pickerCleanup = cleanup;
        pickerImage.addEventListener("click", onImageClick);
        pickerViewport.addEventListener("mousemove", onMouseMove);
        pickerCancel.addEventListener("click", onCancelClick);
        document.addEventListener("keydown", onKeyDown);
    }

    function finishPick() {
        if (pickerCleanup) { pickerCleanup(); }
        picking = false;
        btnPick.disabled = (comp === null);
        setStatus("READY", "idle");
    }

    /* ── Run Tracking / Cancel ────────────────────────────── */
    function onTrackClick() {
        if (tracking) {
            onCancelTracking();
        } else {
            onRunTracking();
        }
    }

    function onRunTracking() {
        if (objects.length === 0 || !cs) { return; }
        if (!childProcess || !fs) {
            log("error: Node.js modules not available (not running in CEP)");
            return;
        }

        tracking = true;
        trackingResults = null;
        btnTrack.textContent = "CANCEL";
        btnTrack.disabled = false;
        btnPick.disabled = true;
        btnGenerate.disabled = true;
        btnClear.disabled = true;
        showProgress(true);
        updateProgress(0, 0);

        var framesFolder = (tempFolder + "/frames").replace(/\\/g, "/");

        /* Check if frames are already exported (skip re-render) */
        var cachedFrames = getCachedFrameCount(framesFolder);
        var expectedFrames = comp ? comp.totalFrames : 0;

        if (cachedFrames > 0 && cachedFrames >= expectedFrames && expectedFrames > 0) {
            log("using " + cachedFrames + " cached frames (skipping render)");
            startPythonTracking({
                framesDir:  framesFolder,
                numFrames:  cachedFrames,
                compWidth:  comp.width,
                compHeight: comp.height,
                fps:        comp.fps
            });
        } else {
            setStatus("EXPORTING FRAMES\u2026", "processing");
            log("exporting all frames\u2026");

            evalScript('st_exportAllFrames("' + escJs(framesFolder) + '")', function (raw) {
                log("export callback received");

                var data;
                try {
                    data = JSON.parse(raw);
                } catch (parseErr) {
                    resetAfterTracking();
                    log("error: invalid response from AE \u2014 " + String(raw).substring(0, 100));
                    return;
                }

                if (data.error) {
                    resetAfterTracking();
                    log("error: " + data.error);
                    return;
                }

                log("exported " + data.numFrames + " frames to " + data.framesDir);
                startPythonTracking(data);
            });
        }
    }

    /* Count existing frame PNGs in directory */
    function getCachedFrameCount(framesFolder) {
        try {
            var files = fs.readdirSync(framesFolder);
            var count = 0;
            for (var i = 0; i < files.length; i++) {
                if (files[i].indexOf("st_frame_") === 0) { count++; }
            }
            return count;
        } catch (e) {
            return 0; // folder doesn't exist
        }
    }

    /* Launch Python tracker with exported frame data */
    function startPythonTracking(data) {
        var clickPoints = [];
        for (var i = 0; i < objects.length; i++) {
            clickPoints.push({
                x: objects[i].x,
                y: objects[i].y,
                object_id: objects[i].id
            });
        }

        var resultsDir = (tempFolder + "/results").replace(/\\/g, "/");
        var config = {
            mode: "segment_and_track",
            frames_dir: data.framesDir,
            click_points: clickPoints,
            output_dir: resultsDir,
            comp_width: data.compWidth,
            comp_height: data.compHeight
        };

        var configStr = JSON.stringify(config);
        var pythonScript = extPath + "/python/supertracery.py";

        setStatus("TRACKING\u2026", "processing");
        log("script: " + pythonScript);

        /* Try venv python first, then system python3, then python */
        var venvPython = extPath + "/python/venv/bin/python3";
        launchPython(venvPython, pythonScript, configStr, resultsDir, function (ok) {
            if (!ok) {
                log("venv not found, trying system python3\u2026");
                launchPython("python3", pythonScript, configStr, resultsDir, function (ok2) {
                    if (!ok2) {
                        log("python3 not found, trying python\u2026");
                        launchPython("python", pythonScript, configStr, resultsDir, function (ok3) {
                            if (!ok3) {
                                resetAfterTracking();
                                log("error: could not start Python. Is python3 installed?");
                            }
                        });
                    }
                });
            }
        });
    }

    function launchPython(pythonCmd, scriptPath, configStr, resultsDir, callback) {
        log("trying: " + pythonCmd);

        var proc;
        try {
            proc = childProcess.spawn(pythonCmd, [scriptPath, configStr], {
                cwd: extPath + "/python"
            });
        } catch (spawnErr) {
            log("spawn failed: " + spawnErr.message);
            callback(false);
            return;
        }

        var callbackFired = false;

        /* Wire up ALL handlers immediately — never delay with setTimeout */

        proc.on("error", function (err) {
            /* "error" fires if the command is not found or can't be spawned */
            pythonProc = null;
            log("process error: " + err.message);
            if (!callbackFired) { callbackFired = true; callback(false); }
        });

        var stdoutBuf = "";

        proc.stdout.on("data", function (chunk) {
            /* If we receive stdout data, the process definitely spawned OK */
            if (!callbackFired) {
                callbackFired = true;
                pythonProc = proc;
                log("python started (pid " + proc.pid + ")");
                callback(true);
            }

            stdoutBuf += chunk.toString();
            var lines = stdoutBuf.split("\n");
            stdoutBuf = lines.pop();

            for (var li = 0; li < lines.length; li++) {
                var line = lines[li].trim();
                if (!line) { continue; }

                var progressMatch = line.match(/^PROGRESS:(\d+)\/(\d+)$/);
                if (progressMatch) {
                    updateProgress(
                        parseInt(progressMatch[1], 10),
                        parseInt(progressMatch[2], 10)
                    );
                    continue;
                }

                if (line === "DONE") {
                    log("tracking complete");
                    continue;
                }

                var errMatch = line.match(/^ERROR:(.+)$/);
                if (errMatch) {
                    log("python error: " + errMatch[1]);
                    continue;
                }

                var infoMatch = line.match(/^INFO:(.+)$/);
                if (infoMatch) {
                    log("tracker: " + infoMatch[1]);
                    progressStdout.textContent = "> " + infoMatch[1];
                    continue;
                }

                log("py: " + line);
            }
        });

        proc.stderr.on("data", function (chunk) {
            /* stderr data also confirms spawn succeeded */
            if (!callbackFired) {
                callbackFired = true;
                pythonProc = proc;
                log("python started (pid " + proc.pid + ")");
                callback(true);
            }

            var errLines = chunk.toString().split("\n");
            for (var ei = 0; ei < errLines.length; ei++) {
                var errLine = errLines[ei].trim();
                if (errLine) { log("py.err: " + errLine); }
            }
        });

        proc.on("close", function (code) {
            pythonProc = null;

            /* If close fires before any stdout/stderr, the process started but
               produced no output (maybe crashed immediately) */
            if (!callbackFired) {
                callbackFired = true;
                log("python exited immediately with code " + code);
                callback(code === 0);
                if (code !== 0) { resetAfterTracking(); }
                return;
            }

            if (!tracking) { return; } // cancelled

            if (code === 0) {
                var resultsPath = resultsDir + "/results.json";
                try {
                    var resultsRaw = fs.readFileSync(resultsPath, "utf8");
                    trackingResults = JSON.parse(resultsRaw);
                    log("results loaded: " + trackingResults.objects.length + " objects tracked");
                    updateProgress(1, 1);
                } catch (readErr) {
                    log("error: could not read results.json \u2014 " + readErr.message);
                }
            } else {
                log("error: Python exited with code " + code);
            }

            resetAfterTracking();
        });

        /* Fallback: if after 3 seconds we haven't heard anything, assume spawn worked
           (Python might be loading large models silently) */
        setTimeout(function () {
            if (!callbackFired) {
                callbackFired = true;
                pythonProc = proc;
                log("python started (pid " + proc.pid + ") \u2014 waiting for output\u2026");
                callback(true);
            }
        }, 3000);
    }

    function onCancelTracking() {
        if (pythonProc) {
            log("cancelling tracking\u2026");
            try {
                pythonProc.kill("SIGTERM");
            } catch (e) {
                log("error: could not kill process");
            }
        }
        tracking = false;
        resetAfterTracking();
        log("tracking cancelled");
    }

    function resetAfterTracking() {
        tracking = false;
        pythonProc = null;
        btnTrack.textContent = "RUN_TRACKING";
        btnPick.disabled = (comp === null);
        btnClear.disabled = false;
        showProgress(false);
        updateButtons();
        setStatus("READY", "idle");
    }

    /* ── Progress bar ─────────────────────────────────────── */
    function showProgress(visible) {
        progressBlock.classList.toggle("active", visible);
    }

    function updateProgress(current, total) {
        var pct = total > 0 ? (current / total * 100) : 0;
        progressFill.style.width = pct + "%";
        progressCount.textContent = pad3(current) + "/" + pad3(total);
        if (current > 0 && total > 0) {
            progressStdout.textContent = "> tracking frame " + current + " of " + total;
        }
    }

    /* ── Generate overlays ────────────────────────────────── */

    /* Extract only polygon data from tracking results for mask shape layers. */
    function extractPolygonData(results) {
        var polyData = { objects: [] };
        for (var i = 0; i < results.objects.length; i++) {
            var obj = results.objects[i];
            var polyFrames = [];
            for (var j = 0; j < obj.frames.length; j++) {
                var f = obj.frames[j];
                polyFrames.push({
                    frame_index: f.frame_index,
                    polygon:     f.polygon || []
                });
            }
            polyData.objects.push({
                object_id: obj.object_id,
                frames:    polyFrames
            });
        }
        return polyData;
    }

    /* Strip polygon/mask data from tracking results before sending to JSX.
       ExtendScript chokes on large JSON — polygons are ~77% of the data
       and the overlay generator doesn't use them. */
    function stripPolygonData(results) {
        var stripped = { objects: [] };
        for (var i = 0; i < results.objects.length; i++) {
            var obj = results.objects[i];
            var strippedFrames = [];
            for (var j = 0; j < obj.frames.length; j++) {
                var f = obj.frames[j];
                strippedFrames.push({
                    frame_index:   f.frame_index,
                    bbox:          f.bbox,
                    centroid:      f.centroid,
                    avg_luma:      f.avg_luma,
                    motion_vector: f.motion_vector
                });
            }
            stripped.objects.push({
                object_id: obj.object_id,
                frames:    strippedFrames
            });
        }
        return stripped;
    }

    function onGenerateOverlays() {
        if (!trackingResults || !cs) { return; }

        btnGenerate.disabled = true;
        setStatus("GENERATING OVERLAYS\u2026", "processing");
        log("generating overlays\u2026");

        /* Build options from current toggle/selector state */
        var colorMap = {};
        for (var i = 0; i < objects.length; i++) {
            var oid = String(objects[i].id);
            colorMap[oid] = objectColors[oid] || COLORS[i % COLORS.length];
        }

        var options = {
            showBBox:         toggles.bbox,
            showMarker:       toggles.marker,
            showLabel:        toggles.label,
            showArrow:        toggles.arrow,
            showMask:         toggles.mask,
            showConnect:      toggles.connect,
            connectionMode:   connMode,
            lineStyle:        lineStyle,
            colors:           colorMap,
            strokeWidth:      strokeWidth,
            overlayOpacity:   overlayOpacity,
            maskFillOpacity:  maskFillOpacity
        };

        /* Write JSON to temp files — avoids evalScript string size limits.
           Strip polygon data from results before writing — ExtendScript can't
           handle the full JSON (polygons are 70-80% of the data and unused
           by the overlay generator). */
        var resultsFile  = (tempFolder + "/overlay_results.json").replace(/\\/g, "/");
        var optionsFile  = (tempFolder + "/overlay_options.json").replace(/\\/g, "/");
        var polygonsFile = (tempFolder + "/overlay_polygons.json").replace(/\\/g, "/");

        try {
            var strippedResults = stripPolygonData(trackingResults);
            fs.writeFileSync(resultsFile, JSON.stringify(strippedResults), "utf8");
            fs.writeFileSync(optionsFile, JSON.stringify(options), "utf8");

            /* Write polygon data only when mask is ON */
            if (toggles.mask) {
                var polyData = extractPolygonData(trackingResults);
                fs.writeFileSync(polygonsFile, JSON.stringify(polyData), "utf8");
            }
        } catch (writeErr) {
            log("error: could not write temp files \u2014 " + writeErr.message);
            btnGenerate.disabled = false;
            setStatus("READY", "idle");
            return;
        }

        var rSize = fs.statSync(resultsFile).size;
        log("data written (" + Math.round(rSize / 1024) + "KB), calling AE\u2026");

        /* JSX reads the files itself — pass polygon path as 3rd arg when mask is ON */
        var jsxCall = 'st_generateOverlaysFromFiles("' + escJs(resultsFile) + '","' + escJs(optionsFile) + '"';
        if (toggles.mask) {
            jsxCall += ',"' + escJs(polygonsFile) + '"';
        }
        jsxCall += ')';

        log("jsx call: " + jsxCall.substring(0, 120) + "\u2026");

        evalScript(
            jsxCall,
            function (raw) {
                log("jsx raw response: " + String(raw).substring(0, 200));
                try {
                    var result = JSON.parse(raw);
                    if (result.error) {
                        log("error: " + result.error);
                    } else {
                        log("overlays generated: " + result.layersCreated + " layers created");
                        if (result.warnings) {
                            log("warnings: " + result.warnings);
                        }
                    }
                } catch (e) {
                    log("error: overlay response \u2014 " + String(raw).substring(0, 200));
                }
                btnGenerate.disabled = false;
                setStatus("READY", "idle");
            }
        );
    }

    /* ── Remove object ─────────────────────────────────────── */
    function onRemoveObject(id) {
        objects = objects.filter(function (o) { return o.id !== id; });
        trackingResults = null; // invalidate results when points change
        renderObjectList();
        updateButtons();
        log("point_" + pad2(id) + " removed");
    }

    /* ── Render object list ────────────────────────────────── */
    function renderObjectList() {
        var rows = objectList.querySelectorAll(".obj-row");
        for (var i = 0; i < rows.length; i++) { rows[i].remove(); }

        if (objects.length === 0) {
            emptyState.style.display = "";
            objectCount.textContent = "[0]";
            return;
        }

        emptyState.style.display = "none";
        objectCount.textContent = "[" + objects.length + "]";

        for (var j = 0; j < objects.length; j++) {
            var o = objects[j];
            var objColor = objectColors[String(o.id)] || COLORS[j % COLORS.length];
            var row = document.createElement("div");
            row.className = "obj-row";
            row.innerHTML =
                '<span class="obj-idx">[' + pad2(o.id) + ']</span>' +
                '<span class="obj-x">X:' + pad4(o.x) + '</span>' +
                '<span class="obj-y">Y:' + pad4(o.y) + '</span>' +
                '<span class="obj-color-swatch" data-id="' + o.id + '" style="background:' + objColor + '"></span>' +
                '<span class="obj-status">[READY]</span>' +
                '<button class="obj-del" data-id="' + o.id + '">[&#215;]</button>';

            row.querySelector(".obj-del").addEventListener("click", (function (id) {
                return function () { onRemoveObject(id); };
            })(o.id));

            row.querySelector(".obj-color-swatch").addEventListener("click", (function (id, swatchEl) {
                return function (evt) {
                    evt.stopPropagation();
                    openColorPicker(id, swatchEl);
                };
            })(o.id, row.querySelector(".obj-color-swatch")));

            objectList.appendChild(row);
        }
    }

    /* ── Color Picker Popup ─────────────────────────────────── */
    var activeColorPopup = null;

    function openColorPicker(objId, swatchEl) {
        closeColorPicker();
        var popup = document.createElement("div");
        popup.className = "color-picker-popup";

        for (var i = 0; i < COLORS.length; i++) {
            var chip = document.createElement("div");
            chip.className = "color-chip";
            chip.style.background = COLORS[i];
            chip.setAttribute("data-color", COLORS[i]);
            chip.addEventListener("click", (function (color) {
                return function (evt) {
                    evt.stopPropagation();
                    objectColors[String(objId)] = color;
                    swatchEl.style.background = color;
                    closeColorPicker();
                    log("color for point_" + pad2(objId) + " = " + color);
                };
            })(COLORS[i]));
            popup.appendChild(chip);
        }

        /* Position near swatch */
        var rect = swatchEl.getBoundingClientRect();
        popup.style.position = "absolute";
        popup.style.left = rect.left + "px";
        popup.style.top  = (rect.bottom + 2) + "px";
        document.body.appendChild(popup);
        activeColorPopup = popup;

        /* Close on outside click */
        setTimeout(function () {
            document.addEventListener("click", closeColorPicker);
        }, 0);
    }

    function closeColorPicker() {
        if (activeColorPopup) {
            activeColorPopup.remove();
            activeColorPopup = null;
            document.removeEventListener("click", closeColorPicker);
        }
    }

    /* ── Toggles ───────────────────────────────────────────── */
    function onToggleClick(e) {
        var row   = e.currentTarget;
        var key   = row.getAttribute("data-key");
        var stEl  = document.getElementById("tog-" + key);
        var isOn  = stEl.getAttribute("data-on") === "true";

        isOn = !isOn;
        toggles[key] = isOn;
        stEl.setAttribute("data-on", isOn ? "true" : "false");
        stEl.textContent = isOn ? "[ON ]" : "[OFF]";
        log("viz." + key + " = " + (isOn ? "on" : "off"));

        /* Show/hide mask fill opacity slider when mask toggle changes */
        if (key === "mask") {
            var maskBlock = document.getElementById("maskFillBlock");
            if (maskBlock) { maskBlock.style.display = isOn ? "" : "none"; }
        }
    }

    /* ── Connection mode ───────────────────────────────────── */
    function onConnModeClick(e) {
        document.querySelectorAll("#connMode .opt").forEach(function (o) { o.classList.remove("active"); });
        e.currentTarget.classList.add("active");
        connMode = e.currentTarget.getAttribute("data-val");
        log("connection_mode = " + connMode);
    }

    /* ── Line style ────────────────────────────────────────── */
    function onLineStyleClick(e) {
        document.querySelectorAll("#lineStyle .opt").forEach(function (o) { o.classList.remove("active"); });
        e.currentTarget.classList.add("active");
        lineStyle = e.currentTarget.getAttribute("data-val");
        log("line_style = " + lineStyle);
    }

    /* ── Clear all ─────────────────────────────────────────── */
    function onClearAll() {
        if (tracking) {
            onCancelTracking();
        }
        objects = [];
        nextId  = 0;
        trackingResults = null;

        /* Wipe cached frames so next RUN_TRACKING does a fresh export */
        clearCachedFrames();

        renderObjectList();
        updateButtons();
        showProgress(false);
        setStatus("READY", "idle");
        log("cleared");
    }

    function clearCachedFrames() {
        if (!fs) { return; }
        var framesFolder = (tempFolder + "/frames").replace(/\\/g, "/");
        try {
            var files = fs.readdirSync(framesFolder);
            for (var i = 0; i < files.length; i++) {
                try { fs.unlinkSync(framesFolder + "/" + files[i]); } catch (e) {}
            }
            log("cleared cached frames");
        } catch (e) {
            // folder doesn't exist, nothing to clear
        }
    }

    /* ── Button state ──────────────────────────────────────── */
    function updateButtons() {
        var hasPoints   = objects.length > 0;
        var hasResults  = trackingResults !== null;
        btnTrack.disabled    = !hasPoints || tracking;
        btnGenerate.disabled = !hasResults;
    }

    /* ── Status ────────────────────────────────────────────── */
    function setStatus(text, cursorMode) {
        statusText.textContent = "STATUS: " + text;
        statusCursor.className = "status-cursor " + (cursorMode || "idle");
    }

    /* ── Log ───────────────────────────────────────────────── */
    function log(msg) {
        var line = document.createElement("div");
        line.className = "log-line";
        line.innerHTML =
            '<span class="log-prefix">&gt;</span>' +
            '<span class="log-text">' + escHtml(msg) + '</span>';
        logArea.appendChild(line);
        logArea.scrollTop = logArea.scrollHeight;

        var lines = logArea.querySelectorAll(".log-line");
        if (lines.length > 80) { lines[0].remove(); }
    }

    /* ── Utilities ─────────────────────────────────────────── */
    function pad2(n) { return ("00"   + n).slice(-2); }
    function pad3(n) { return ("000"  + n).slice(-3); }
    function pad4(n) { return ("0000" + n).slice(-4); }

    function escHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function escJs(s) {
        return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    /* ── Expose for other steps ────────────────────────────── */
    window.ST = {
        objects:   function () { return objects; },
        toggles:   function () { return toggles; },
        connMode:  function () { return connMode; },
        lineStyle: function () { return lineStyle; },
        log:       log,
        setStatus: setStatus,
        pad2: pad2, pad3: pad3, pad4: pad4
    };

    /* ── Start ─────────────────────────────────────────────── */
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

})();
