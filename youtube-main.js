(function() {
  if (window.__youtube_sniffer_injected__) return;
  window.__youtube_sniffer_injected__ = true;

  console.log("[YouTube Sniffer] Main world script initialized via manifest.");

  function extractDecipherer(jsText) {
    try {
      // Method 1: Search for the signature decipher call site: e.g. .sig||abc(a) or .signature||abc(a)
      let funcName = null;
      const callSiteRegexes = [
        /\.sig\s*\|\|\s*([a-zA-Z0-9$]+)\(/,
        /\.signature\s*\|\|\s*([a-zA-Z0-9$]+)\(/,
        /yt\.akamaized\.net.*?&sig=\s*([a-zA-Z0-9$]+)\(/,
        /url_encoded_fmt_stream_map.*?&sig=\s*([a-zA-Z0-9$]+)\(/
      ];

      for (const rx of callSiteRegexes) {
        const m = jsText.match(rx);
        if (m) {
          funcName = m[1];
          break;
        }
      }

      let match = null;
      let funcBody = null;
      let paramName = "a";

      if (funcName) {
        console.log("[YouTube Sniffer] Found decipher function name via call site:", funcName);
        const escapedFuncName = funcName.replace(/\$/g, "\\$");
        const funcRegex = new RegExp(
          "(?:function\\s+" + escapedFuncName + "|(?:var\\s+)?" + escapedFuncName + "\\s*=\\s*function)\\s*\\(\\s*([a-zA-Z0-9$]+)\\s*\\)\\s*\\{\\s*([\\s\\S]+?)\\}"
        );
        const m = jsText.match(funcRegex);
        if (m) {
          paramName = m[1];
          funcBody = m[2];
          console.log("[YouTube Sniffer] Successfully extracted body for function:", funcName);
        }
      }

      // Method 2 Fallback: Scan the whole file for the signature split/join pattern structure
      if (!funcBody) {
        console.log("[YouTube Sniffer] Call site extraction failed, falling back to signature split/join pattern match...");
        const mainFuncRegex = /(?:function\s+([a-zA-Z0-9$]+)|([a-zA-Z0-9$]+)\s*=\s*function)\s*\(\s*([a-zA-Z0-9$]+)\s*\)\s*\{\s*[\s\S]*?[a-zA-Z0-9$]+\s*=\s*[a-zA-Z0-9$]+\.split\(\s*["'"]["'"]\s*\)\s*[;,]\s*([\s\S]+?)return\s+[a-zA-Z0-9$]+\.join\(\s*["'"]["'"]\s*\)/;
        const m = jsText.match(mainFuncRegex);
        if (m) {
          funcName = m[1] || m[2];
          paramName = m[3];
          funcBody = m[4];
          console.log("[YouTube Sniffer] Found split/join pattern match. Function:", funcName);
        }
      }

      if (!funcBody) {
        console.warn("[YouTube Sniffer] All decipher extraction methods failed.");
        return null;
      }

      const helperNameMatch = funcBody.match(/([a-zA-Z0-9$]+)\.[a-zA-Z0-9$]+\(/);
      if (!helperNameMatch) return null;
      const helperName = helperNameMatch[1];

      // Escape dollar sign for RegExp
      const escapedHelperName = helperName.replace(/\$/g, "\\$");
      const helperRegex = new RegExp("(?:var\\s+)?" + escapedHelperName + "\\s*=\\s*\\{([\\s\\S]+?)\\}[;,\\n]");
      const helperMatch = jsText.match(helperRegex);
      if (!helperMatch) return null;

      const helperBody = helperMatch[1];

      // Matches both reverse:function(a,b){...} and ES6 shorthand reverse(a,b){...} with any parameter names
      const methodRegex = /([a-zA-Z0-9$]+)\s*(?::\s*function)?\s*\(\s*[a-zA-Z0-9$]+\s*(?:,\s*[a-zA-Z0-9$]+)?\s*\)\s*\{([\s\S]+?)\}/g;
      const methods = {};
      let m;
      while ((m = methodRegex.exec(helperBody)) !== null) {
        const name = m[1];
        const body = m[2];
        if (body.includes("reverse")) {
          methods[name] = "reverse";
        } else if (body.includes("splice")) {
          methods[name] = "slice";
        } else {
          methods[name] = "swap";
        }
      }

      const escapedParamName = paramName.replace(/\$/g, "\\$");
      const opRegex = new RegExp(escapedHelperName + "\\.([a-zA-Z0-9$]+)\\(" + escapedParamName + ",\\s*(\\d+)\\)", "g");
      const operations = [];
      let op;
      while ((op = opRegex.exec(funcBody)) !== null) {
        const methodName = op[1];
        const arg = parseInt(op[2], 10);
        const action = methods[methodName];
        if (action) {
          operations.push({ action, arg });
        }
      }

      return function(sig) {
        const arr = sig.split("");
        for (const op of operations) {
          if (op.action === "reverse") {
            arr.reverse();
          } else if (op.action === "slice") {
            arr.splice(0, op.arg);
          } else if (op.action === "swap") {
            const c = arr[0];
            arr[0] = arr[op.arg % arr.length];
            arr[op.arg % arr.length] = c;
          }
        }
        return arr.join("");
      };
    } catch (e) {
      console.error("[YouTube Sniffer] extractDecipherer error:", e);
      return null;
    }
  }

  let cachedDecipherer = null;
  let cachedJsUrl = null;
  let failedToExtractDecipherer = false;

  async function getDecipherer() {
    let jsUrl = null;
    try {
      if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.assets) {
        jsUrl = window.ytplayer.config.assets.js;
      }
      if (!jsUrl) {
        const scriptEl = document.querySelector('script[src*="base.js"]') || document.querySelector('script[src*="player_ias"]');
        if (scriptEl) jsUrl = scriptEl.src;
      }
    } catch (e) {}

    if (!jsUrl) {
      console.warn("[YouTube Sniffer] Could not find base.js URL.");
      return null;
    }

    // Normalize relative URLs
    if (jsUrl.startsWith("/")) {
      jsUrl = window.location.origin + jsUrl;
    }

    if (cachedDecipherer && cachedJsUrl === jsUrl) {
      return cachedDecipherer;
    }

    if (failedToExtractDecipherer && cachedJsUrl === jsUrl) {
      return null;
    }

    console.log("[YouTube Sniffer] Fetching base.js for signature deciphering:", jsUrl);
    try {
      const response = await fetch(jsUrl);
      const jsText = await response.text();
      const decipherer = extractDecipherer(jsText);
      if (decipherer) {
        cachedDecipherer = decipherer;
        cachedJsUrl = jsUrl;
        failedToExtractDecipherer = false;
        console.log("[YouTube Sniffer] Successfully extracted signature decipherer!");
        return decipherer;
      } else {
        failedToExtractDecipherer = true;
        cachedJsUrl = jsUrl;
        console.warn("[YouTube Sniffer] Failed to extract decipherer from JS text.");
      }
    } catch (e) {
      failedToExtractDecipherer = true;
      cachedJsUrl = jsUrl;
      console.error("[YouTube Sniffer] Failed to fetch/extract decipherer:", e);
    }
    return null;
  }

  async function checkAndPostPlayerResponse() {
    let response = null;
    try {
      if (window.ytInitialPlayerResponse) {
        response = window.ytInitialPlayerResponse;
      } else {
        const player = document.getElementById("movie_player");
        if (player && typeof player.getPlayerResponse === "function") {
          response = player.getPlayerResponse();
        }
      }
    } catch (e) {}

    if (!response) return;

    try {
      const responseCopy = {};
      if (response.streamingData) {
        responseCopy.streamingData = JSON.parse(JSON.stringify(response.streamingData));
      }
      if (response.videoDetails) {
        responseCopy.videoDetails = JSON.parse(JSON.stringify(response.videoDetails));
      }

      const streamingData = responseCopy.streamingData;

      // 1. Post the original response immediately (progressive formats will have URLs and display instantly if available)
      window.postMessage({
        type: "YOUTUBE_PLAYER_RESPONSE",
        response: responseCopy,
        title: document.title
      }, "*");

      // 2. Asynchronously decipher any signatures and post an updated response once done
      if (streamingData) {
        const formats = [];
        if (streamingData.formats) formats.push(...streamingData.formats);
        if (streamingData.adaptiveFormats) formats.push(...streamingData.adaptiveFormats);

        const hasCiphers = formats.some(f => !f.url && (f.signatureCipher || f.cipher));
        if (hasCiphers) {
          getDecipherer().then((decipherer) => {
            if (decipherer) {
              let decipheredAny = false;
              formats.forEach(f => {
                if (!f.url && (f.signatureCipher || f.cipher)) {
                  try {
                    const cipher = f.signatureCipher || f.cipher;
                    const params = new URLSearchParams(cipher);
                    const s = params.get("s");
                    const url = params.get("url");
                    const sp = params.get("sp") || "sig";
                    if (s && url) {
                      const decipheredSig = decipherer(s);
                      const separator = url.includes("?") ? "&" : "?";
                      f.url = url + separator + sp + "=" + encodeURIComponent(decipheredSig);
                      delete f.signatureCipher;
                      delete f.cipher;
                      decipheredAny = true;
                    }
                  } catch (err) {
                    console.error("[YouTube Sniffer] Deciphering error for format:", err);
                  }
                }
              });

              if (decipheredAny) {
                console.log("[YouTube Sniffer] Posting updated deciphered player response.");
                window.postMessage({
                  type: "YOUTUBE_PLAYER_RESPONSE",
                  response: responseCopy,
                  title: document.title
                }, "*");
              }
            }
          }).catch(err => {
            console.error("[YouTube Sniffer] Async deciphering failed:", err);
          });
        }
      }
    } catch (e) {
      console.error("[YouTube Sniffer] Error cloning/parsing response:", e);
    }
  }

  // Check immediately
  checkAndPostPlayerResponse();

  window.addEventListener("load", () => {
    setTimeout(checkAndPostPlayerResponse, 500);
  });
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(checkAndPostPlayerResponse, 500);
  });

  // Check on player state changes or page navigations
  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(checkAndPostPlayerResponse, 500);
  });
  document.addEventListener("yt-page-data-updated", () => {
    setTimeout(checkAndPostPlayerResponse, 500);
  });

  // Intercept dynamic XHR/fetch player responses
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = args[0];
    if (typeof url === 'string' && url.includes('/youtubei/v1/player')) {
      try {
        setTimeout(checkAndPostPlayerResponse, 500);
      } catch (e) {}
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      if (this._url && this._url.includes('/youtubei/v1/player')) {
        try {
          setTimeout(checkAndPostPlayerResponse, 500);
        } catch (e) {}
      }
    });
    return originalSend.apply(this, arguments);
  };

  // Unconditional periodic check to capture player initialization dynamically
  setInterval(checkAndPostPlayerResponse, 2000);
})();
