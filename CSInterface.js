/**
 * CSInterface - Adobe CEP (Common Extensibility Platform) Interface
 * Minimal bundled version for SuperTracery.
 *
 * This provides the bridge between the CEP panel (HTML/JS) and
 * the host application (After Effects) via ExtendScript.
 *
 * For the full official version, see:
 * https://github.com/nickthecoder/nickthecoder-CSInterface
 *
 * NOTE: In production, replace this with the full CSInterface.js
 * from Adobe's CEP-Resources repository matching your CEP version.
 */

/* globals window, cep */

var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};

var ColorType = {
    RGB: "rgb",
    GRADIENT: "gradient",
    NONE: "none"
};

/**
 * @class CSInterface
 * Main interface to the CEP infrastructure.
 */
function CSInterface() {}

/**
 * Retrieves the scale factor of the content.
 */
CSInterface.prototype.getScaleFactor = function () {
    try {
        return window.__adobe_cep__.getScaleFactor();
    } catch (e) {
        return 1;
    }
};

/**
 * Sets the scale factor of the content.
 */
CSInterface.prototype.setScaleFactor = function (scaleFactor) {
    try {
        window.__adobe_cep__.setScaleFactor(scaleFactor);
    } catch (e) {}
};

/**
 * Retrieves a system path.
 * @param {string} pathType - A SystemPath constant.
 * @returns {string} The system path string.
 */
CSInterface.prototype.getSystemPath = function (pathType) {
    try {
        var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
        return path;
    } catch (e) {
        return "";
    }
};

/**
 * Evaluates an ExtendScript expression in the host application.
 * @param {string} script - The ExtendScript expression to evaluate.
 * @param {function} [callback] - Optional callback with result string.
 */
CSInterface.prototype.evalScript = function (script, callback) {
    try {
        if (callback === null || callback === undefined) {
            callback = function () {};
        }
        window.__adobe_cep__.evalScript(script, callback);
    } catch (e) {
        if (callback) { callback("EvalScript error: " + e.message); }
    }
};

/**
 * Retrieves the unique identifier of the application.
 */
CSInterface.prototype.getApplicationID = function () {
    try {
        var appId = window.__adobe_cep__.getApplicationID();
        return appId;
    } catch (e) {
        return "";
    }
};

/**
 * Retrieves host environment data.
 * @returns {object} Host environment object.
 */
CSInterface.prototype.getHostEnvironment = function () {
    try {
        var envStr = window.__adobe_cep__.getHostEnvironment();
        return JSON.parse(envStr);
    } catch (e) {
        return {};
    }
};

/**
 * Closes this extension panel.
 */
CSInterface.prototype.closeExtension = function () {
    try {
        window.__adobe_cep__.closeExtension();
    } catch (e) {}
};

/**
 * Retrieves the extension ID.
 */
CSInterface.prototype.getExtensionID = function () {
    try {
        return window.__adobe_cep__.getExtensionID();
    } catch (e) {
        return "";
    }
};

/**
 * Registers an interest in a CEP event.
 * @param {string} type - The event type.
 * @param {function} listener - The callback function.
 * @param {object} [obj] - Optional context.
 */
CSInterface.prototype.addEventListener = function (type, listener, obj) {
    try {
        window.__adobe_cep__.addEventListener(type, listener, obj);
    } catch (e) {}
};

/**
 * Removes a registered event listener.
 * @param {string} type - The event type.
 * @param {function} listener - The callback function.
 * @param {object} [obj] - Optional context.
 */
CSInterface.prototype.removeEventListener = function (type, listener, obj) {
    try {
        window.__adobe_cep__.removeEventListener(type, listener, obj);
    } catch (e) {}
};

/**
 * Dispatches an event.
 * @param {CSEvent} event - The event to dispatch.
 */
CSInterface.prototype.dispatchEvent = function (event) {
    try {
        if (typeof event.data === "object") {
            event.data = JSON.stringify(event.data);
        }
        window.__adobe_cep__.dispatchEvent(event);
    } catch (e) {}
};

/**
 * Triggers a request to open a URL in the default browser.
 * @param {string} url - The URL to open.
 */
CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    try {
        cep.util.openURLInDefaultBrowser(url);
    } catch (e) {}
};

/**
 * Retrieves the current API version.
 * @returns {object} Version object with major, minor, micro.
 */
CSInterface.prototype.getCurrentApiVersion = function () {
    try {
        var versionStr = window.__adobe_cep__.getCurrentApiVersion();
        var versionObj = JSON.parse(versionStr);
        return versionObj;
    } catch (e) {
        return { major: 11, minor: 0, micro: 0 };
    }
};

/**
 * Requests permission to open a file dialog.
 * @param {string} title - Dialog title.
 * @param {string} [initialPath] - Starting directory.
 * @param {Array} [fileTypes] - Allowed file types.
 * @param {function} callback - Result callback.
 */
CSInterface.prototype.requestOpenExtension = function (title, initialPath, fileTypes, callback) {
    try {
        window.__adobe_cep__.requestOpenExtension(title, initialPath, fileTypes, callback);
    } catch (e) {
        if (callback) { callback({ err: e.message }); }
    }
};

/**
 * Gets the networking preferences.
 */
CSInterface.prototype.getNetworkPreferences = function () {
    try {
        var prefs = window.__adobe_cep__.getNetworkPreferences();
        return JSON.parse(prefs);
    } catch (e) {
        return {};
    }
};

/**
 * Loads a binary into the panel's context.
 */
CSInterface.prototype.initResourceBundle = function () {
    try {
        window.__adobe_cep__.initResourceBundle();
    } catch (e) {}
};

/**
 * CSEvent — an event object for the CEP event system.
 */
function CSEvent(type, scope, appId, extensionId) {
    this.type = type;
    this.scope = scope || "APPLICATION";
    this.appId = appId || "";
    this.extensionId = extensionId || "";
    this.data = "";
}
