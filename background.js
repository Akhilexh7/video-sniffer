import { parseM3U8 } from './hls-parser.js';

const MIN_DIRECT_MEDIA_SIZE = 1 * 1024 * 1024; // 1MB — filters out small media files, tracking assets, and ad clips

const YOUTUBE_ITAGS = {
  18: { resolution: "360p (MP4)", type: "mp4", title: "YouTube Video (with Audio)", hasAudio: true, hasVideo: true },
  22: { resolution: "720p (MP4)", type: "mp4", title: "YouTube Video (with Audio)", hasAudio: true, hasVideo: true },
  37: { resolution: "1080p (MP4)", type: "mp4", title: "YouTube Video (with Audio)", hasAudio: true, hasVideo: true },
  38: { resolution: "3072p (MP4)", type: "mp4", title: "YouTube Video (with Audio)", hasAudio: true, hasVideo: true },
  
  // Video only (MP4 / AVC)
  137: { resolution: "1080p (MP4)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  136: { resolution: "720p (MP4)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  135: { resolution: "480p (MP4)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  134: { resolution: "360p (MP4)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  133: { resolution: "240p (MP4)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  160: { resolution: "144p (MP4)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  
  // Video only (WebM / VP9)
  248: { resolution: "1080p (WebM)", type: "webm", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  247: { resolution: "720p (WebM)", type: "webm", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  244: { resolution: "480p (WebM)", type: "webm", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  243: { resolution: "360p (WebM)", type: "webm", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  271: { resolution: "1440p (WebM)", type: "webm", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  313: { resolution: "2160p (4K, WebM)", type: "webm", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  
  // Video only (AV1)
  399: { resolution: "1080p (AV1)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  398: { resolution: "720p (AV1)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  397: { resolution: "480p (AV1)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  396: { resolution: "360p (AV1)", type: "mp4", title: "YouTube Video (Video Only)", hasAudio: false, hasVideo: true },
  
  // Audio only
  140: { resolution: "128kbps (M4A)", type: "m4a", title: "YouTube Audio", hasAudio: true, hasVideo: false },
  251: { resolution: "160kbps (WebM)", type: "webm", title: "YouTube Audio", hasAudio: true, hasVideo: false },
  139: { resolution: "48kbps (M4A)", type: "m4a", title: "YouTube Audio", hasAudio: true, hasVideo: false },
  171: { resolution: "128kbps (WebM)", type: "webm", title: "YouTube Audio", hasAudio: true, hasVideo: false },
  249: { resolution: "50kbps (WebM)", type: "webm", title: "YouTube Audio", hasAudio: true, hasVideo: false },
  250: { resolution: "70kbps (WebM)", type: "webm", title: "YouTube Audio", hasAudio: true, hasVideo: false }
};

function cleanYoutubeUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    url.searchParams.delete("range");
    url.searchParams.delete("rn");
    url.searchParams.delete("obufp");
    url.searchParams.delete("index");
    url.searchParams.delete("sq");
    return url.href;
  } catch (e) {
    return urlStr;
  }
}

console.log("[Background] Service worker (re)started at", new Date().toISOString());

let nativePort = null;
const recentlyActiveTabIds = new Set();
const activeTabTimeouts = new Map();

function markTabAsActive(tabId) {
  if (!tabId || tabId < 0) return;
  recentlyActiveTabIds.add(tabId);
  if (activeTabTimeouts.has(tabId)) {
    clearTimeout(activeTabTimeouts.get(tabId));
  }
  const timeoutId = setTimeout(() => {
    recentlyActiveTabIds.delete(tabId);
    activeTabTimeouts.delete(tabId);
  }, 10 * 60 * 1000); // 10 min window to be safe
  activeTabTimeouts.set(tabId, timeoutId);
}

// Mark active tabs at startup
chrome.tabs.query({ active: true }, (tabs) => {
  if (tabs) {
    tabs.forEach(t => markTabAsActive(t.id));
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  markTabAsActive(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active) {
    markTabAsActive(tabId);
  }
});

// Tab-based video database
// tabId -> Array of detected video objects
let tabVideoRegistry = new Map();
let lastTabUrls = new Map();
let dnrRuleMap = new Map();
let dnrUrlRegistry = new Map();
let nextDnrRuleId = 100000;

async function loadRegistryFromStorage() {
  try {
    const stored = await chrome.storage.session.get([
      "tabVideoRegistry", 
      "lastTabUrls", 
      "dnrRuleMap", 
      "dnrUrlRegistry",
      "nextDnrRuleId"
    ]);
    if (stored) {
      if (stored.tabVideoRegistry) {
        tabVideoRegistry = new Map(Object.entries(stored.tabVideoRegistry).map(([k, v]) => [Number(k), v]));
        console.log("[Background] Restored tabVideoRegistry from session storage:", tabVideoRegistry.size, "tabs");
      }
      if (stored.lastTabUrls) {
        lastTabUrls = new Map(Object.entries(stored.lastTabUrls).map(([k, v]) => [Number(k), v]));
      }
      if (stored.dnrRuleMap) {
        dnrRuleMap = new Map(Object.entries(stored.dnrRuleMap));
      }
      if (stored.dnrUrlRegistry) {
        dnrUrlRegistry = new Map(Object.entries(stored.dnrUrlRegistry).map(([k, v]) => [Number(k), v]));
      }
      if (stored.nextDnrRuleId) {
        nextDnrRuleId = stored.nextDnrRuleId;
      }
    }
  } catch (e) {
    console.error("[Background] Failed to load registry from session storage:", e);
  }
}

// Debounce helper with maxWait to satisfy Optimization 4
function debounceWithMaxWait(fn, delay, maxWait) {
  let timer = null;
  let maxTimer = null;
  let lastCall = 0;

  const flush = async (...args) => {
    if (timer) clearTimeout(timer);
    if (maxTimer) clearTimeout(maxTimer);
    timer = null;
    maxTimer = null;
    lastCall = 0;
    await fn(...args);
  };

  return (...args) => {
    const now = Date.now();
    if (!lastCall) {
      lastCall = now;
    }

    if (timer) clearTimeout(timer);

    if (now - lastCall >= maxWait) {
      flush(...args);
    } else {
      timer = setTimeout(() => flush(...args), delay);
      if (!maxTimer) {
        maxTimer = setTimeout(() => flush(...args), maxWait - (now - lastCall));
      }
    }
  };
}

const persistRegistry = async () => {
  try {
    const tabVideoRegistryObj = Object.fromEntries(tabVideoRegistry);
    const lastTabUrlsObj = Object.fromEntries(lastTabUrls);
    const dnrRuleMapObj = Object.fromEntries(dnrRuleMap);
    const dnrUrlRegistryObj = Object.fromEntries(dnrUrlRegistry);
    
    await chrome.storage.session.set({ 
      tabVideoRegistry: tabVideoRegistryObj, 
      lastTabUrls: lastTabUrlsObj,
      dnrRuleMap: dnrRuleMapObj,
      dnrUrlRegistry: dnrUrlRegistryObj,
      nextDnrRuleId
    });
  } catch (e) {
    console.error("[Background] Failed to persist registry to session storage:", e);
  }
};

const persistDebounced = debounceWithMaxWait(persistRegistry, 250, 2000);

// Initialize registry load immediately
loadRegistryFromStorage();

// Flush pending writes on suspend
chrome.runtime.onSuspend.addListener(() => {
  console.log("[Background] Service worker suspending, flushing pending writes.");
  persistRegistry();
});

// Active HLS downloads: tabId -> { url, qualityTitle, progress }
const activeDownloads = {};

let creatingOffscreen; // Global promise for offscreen lifecycle
const tabRecentAudios = {}; // tabId -> Array of { url, contentType, timestamp }

console.log("[Detector] Service Worker initialized.");

// Register declarativeNetRequest rules to inject Origin/Referer headers for the extension's fetches
async function registerDnrRulesForDownload(tabId, pageUrl, mediaUrl = pageUrl) {
  if (!chrome.declarativeNetRequest) {
    console.warn("[DNR] declarativeNetRequest API not available.");
    return;
  }
  
  if (!pageUrl || (!pageUrl.startsWith("http://") && !pageUrl.startsWith("https://"))) {
    return;
  }
  
  dnrUrlRegistry.set(tabId, pageUrl);
  
  try {
    const pageUrlObj = new URL(pageUrl);
    const mediaUrlObj = new URL(mediaUrl);
    const origin = pageUrlObj.origin;
    const mediaHost = mediaUrlObj.hostname;
    const key = `${tabId}:${mediaUrlObj.origin}`;
    
    let ruleId = dnrRuleMap.get(key);
    if (!ruleId) {
      ruleId = nextDnrRuleId++;
      dnrRuleMap.set(key, ruleId);
      persistDebounced();
    }
    
    const rules = [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set',
              value: pageUrl
            },
            {
              header: 'Origin',
              operation: 'set',
              value: origin
            }
          ],
          responseHeaders: [
            {
              header: 'Access-Control-Allow-Origin',
              operation: 'set',
              value: `chrome-extension://${chrome.runtime.id}`
            },
            {
              header: 'Access-Control-Allow-Credentials',
              operation: 'set',
              value: 'true'
            },
            {
              header: 'Access-Control-Allow-Headers',
              operation: 'set',
              value: '*'
            },
            {
              header: 'Access-Control-Allow-Methods',
              operation: 'set',
              value: '*'
            }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          urlFilter: `||${mediaHost}^`,
          resourceTypes: ['xmlhttprequest']
        }
      }
    ];
    
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: rules
    });
    
    // Verify it actually stuck
    const active = await chrome.declarativeNetRequest.getSessionRules();
    const confirmed = active.some(r => r.id === ruleId);
    if (!confirmed) {
      console.warn(`[DNR] Rule for tab ${tabId} (origin ${origin}) did not confirm active, retrying once...`);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId],
        addRules: rules
      });
    }
    console.log(`[DNR] Registered headers rules for Tab ${tabId}: ${mediaHost} with referer ${origin}. RuleId: ${ruleId}`);
  } catch (e) {
    console.error("[DNR] Failed to register declarativeNetRequest rules:", e);
  }
}

async function unregisterDnrRulesForDownload(tabId) {
  if (!chrome.declarativeNetRequest) return;
  try {
    const ruleIdsToRemove = [];
    const keysToRemove = [];
    
    for (const [key, ruleId] of dnrRuleMap.entries()) {
      if (key.startsWith(`${tabId}:`)) {
        ruleIdsToRemove.push(ruleId);
        keysToRemove.push(key);
      }
    }
    
    if (ruleIdsToRemove.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ruleIdsToRemove
      });
      keysToRemove.forEach(k => dnrRuleMap.delete(k));
      persistDebounced();
      console.log(`[DNR] Unregistered headers rules for Tab ${tabId}: rules ${ruleIdsToRemove.join(', ')}`);
    }
  } catch (e) {
    console.error("[DNR] Failed to unregister rules:", e);
  }
}

const tabYoutubeMediaState = {};

function processYoutubeMedia(tabId, item, pageTitle) {
  console.log(`[Background] processYoutubeMedia called for tab ${tabId}. itag: ${item.itag}, videoId: ${item.videoId}, url: ${item.url ? item.url.substring(0, 120) : "none"}`);
  
  if (!tabYoutubeMediaState[tabId] || (item.videoId && tabYoutubeMediaState[tabId].videoId !== item.videoId)) {
    console.log(`[Background] New YouTube video detected (videoId: ${item.videoId}). Resetting media state for Tab ${tabId}.`);
    if (tabVideoRegistry.has(tabId)) {
      tabVideoRegistry.set(tabId, tabVideoRegistry.get(tabId).filter(v => v.type !== "youtube"));
    }
    tabYoutubeMediaState[tabId] = {
      videoId: item.videoId || null,
      title: pageTitle || "YouTube Video",
      thumbnail: item.thumbnail || null,
      videoUrls: {},
      audioUrls: {}
    };
  }

  const state = tabYoutubeMediaState[tabId];
  if (item.title && (!state.title || state.title === "YouTube Video")) state.title = item.title;
  if (item.thumbnail && !state.thumbnail) state.thumbnail = item.thumbnail;

  const itag = Number(item.itag);
  let isVideo = item.hasVideo;
  let isAudio = item.hasAudio;
  let resolution = item.resolution;
  let container = item.container;

  // Fallback to YOUTUBE_ITAGS if properties are not directly provided (e.g. from network interception)
  if (typeof isVideo === "undefined" || typeof isAudio === "undefined") {
    const itagInfo = YOUTUBE_ITAGS[itag];
    if (itagInfo) {
      isVideo = itagInfo.hasVideo;
      isAudio = itagInfo.hasAudio;
      resolution = itagInfo.resolution;
      container = itagInfo.type;
    } else {
      console.log(`[Background] Unknown YouTube itag without metadata: ${itag}`);
      return;
    }
  }

  const isProgressive = isVideo && isAudio;

  if (isProgressive) {
    state.videoUrls[itag] = { url: cleanYoutubeUrl(item.url), resolution, container, isProgressive: true };
    console.log(`[Background] Registered progressive video itag ${itag} for tab ${tabId}. Total video urls:`, Object.keys(state.videoUrls));
  } else if (isVideo && !isAudio) {
    state.videoUrls[itag] = { url: cleanYoutubeUrl(item.url), resolution, container, isProgressive: false };
    console.log(`[Background] Registered video itag ${itag} for tab ${tabId}. Total video urls:`, Object.keys(state.videoUrls));
  } else if (isAudio && !isVideo) {
    state.audioUrls[itag] = { url: cleanYoutubeUrl(item.url), resolution, container };
    console.log(`[Background] Registered audio itag ${itag} for tab ${tabId}. Total audio urls:`, Object.keys(state.audioUrls));
  }

  // Log counts for Bug #4
  console.log(`[Background] Videos total: ${Object.keys(state.videoUrls).length}`);
  console.log(`[Background] Audios total: ${Object.keys(state.audioUrls).length}`);

  // Re-evaluate pairings
  const pairedQualities = [];
  Object.keys(state.videoUrls).forEach((videoItagStr) => {
    const videoItag = Number(videoItagStr);
    const videoObj = state.videoUrls[videoItag];

    if (videoObj.isProgressive) {
      pairedQualities.push({
        resolution: videoObj.resolution,
        videoUrl: videoObj.url,
        audioUrl: null,
        container: videoObj.container,
        videoItag: videoItag,
        audioItag: null,
        isProgressive: true
      });
      return;
    }

    const isWebmVideo = videoObj.container === "webm";
    let audioUrl = null;
    let bestAudioItag = null;
    let bestAudioBitrate = 0;

    Object.keys(state.audioUrls).forEach((audioItagStr) => {
      const audioItag = Number(audioItagStr);
      const audioObj = state.audioUrls[audioItag];
      const isWebmAudio = audioObj.container === "webm";
      if (isWebmVideo !== isWebmAudio) return;

      const bitrate = parseInt(audioObj.resolution) || (audioItag === 140 || audioItag === 251 || audioItag === 171 ? 128 : 50);
      if (bitrate > bestAudioBitrate) {
        bestAudioBitrate = bitrate;
        audioUrl = audioObj.url;
        bestAudioItag = audioItag;
      }
    });

    if (!audioUrl) {
      const firstAudioItag = Object.keys(state.audioUrls)[0];
      if (firstAudioItag) {
        audioUrl = state.audioUrls[firstAudioItag].url;
        bestAudioItag = Number(firstAudioItag);
      }
    }

    if (audioUrl) {
      pairedQualities.push({
        resolution: videoObj.resolution,
        videoUrl: videoObj.url,
        audioUrl: audioUrl,
        container: videoObj.container,
        videoItag: videoItag,
        audioItag: bestAudioItag,
        isProgressive: false
      });
    }
  });

  console.log(`[Background] Pairing summary for tab ${tabId}. Paired count: ${pairedQualities.length}`);

  if (pairedQualities.length > 0) {
    pairedQualities.sort((a, b) => {
      const resA = parseInt(a.resolution) || 0;
      const resB = parseInt(b.resolution) || 0;
      return resB - resA;
    });

    console.log(`[Background] Registering unified YouTube card for tab ${tabId} with ${pairedQualities.length} qualities.`);
    registerVideo(tabId, {
      url: "youtube://multi",
      type: "youtube",
      quality: "YouTube",
      resolution: "Multi Quality",
      title: state.title,
      thumbnail: state.thumbnail,
      qualities: pairedQualities,
      pageTitle: state.title
    });
  }
}

// 1. Network Interception via webRequest API (equivalent to shouldInterceptRequest in Android)
// Inspects response headers to confirm content types while ignoring HTML pages and HLS .ts segments
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, type, responseHeaders, statusCode } = details;
    if (tabId < 0) return;


    // Check resourceType FIRST (cheapest early-exit, no string/URL parsing)
    if (type === "image" || type === "stylesheet" || type === "font" || type === "script") {
      return;
    }

    // Intercept YouTube streams and prevent them from falling through to generic detection
    if (url.includes("googlevideo.com") || url.includes("youtube.com")) {
      if (url.includes("/videoplayback")) {
        try {
          const urlObj = new URL(url);
          const itagStr = urlObj.searchParams.get("itag");
          if (itagStr) {
            const itag = parseInt(itagStr);
            console.log(`[Background Network] Intercepted googlevideo playback request. itag: ${itag}`);
            chrome.tabs.get(tabId, (tab) => {
              let title = "YouTube Video";
              let favIconUrl = null;
              if (chrome.runtime.lastError || !tab) {
                console.warn("[Background Network] Failed to get tab info for tabId:", tabId, "using fallbacks.");
              } else {
                title = tab.title || "YouTube Video";
                favIconUrl = tab.favIconUrl || null;
              }
              processYoutubeMedia(tabId, {
                url: url,
                itag: itag,
                thumbnail: favIconUrl
              }, title);
            });
          }
        } catch (e) {
          console.error("[Detector] Error intercepting YouTube stream:", e);
        }
      }
      return; // Always return early for YouTube/googlevideo URLs to bypass generic detectors
    }

    // Filter out navigation frames (which represent HTML pages)
    if (type === "main_frame" || type === "sub_frame") {
      return;
    }

    // Filter out common ad/analytics scripts
    if (url.includes("google-analytics") || url.includes("doubleclick") || url.includes("applovin") || url.includes("mbridge")) {
      return;
    }

    // Filter out obvious preview/teaser/ad video keywords
    const urlLower = url.toLowerCase();
    if (
      urlLower.includes("preview") || 
      urlLower.includes("teaser") || 
      urlLower.includes("/ad/") || 
      urlLower.includes("/ads/") || 
      urlLower.includes("advertisement") ||
      urlLower.includes("promo") || 
      urlLower.includes("thumbnail") || 
      urlLower.includes("intro") || 
      urlLower.includes("outro")
    ) {
      return;
    }

    const contentTypeHeader = responseHeaders.find(
      (h) => h.name.toLowerCase() === "content-type"
    );

    if (contentTypeHeader) {
      const contentType = contentTypeHeader.value.toLowerCase();

      // EXPLICITLY REJECT and ignore standard webpage text/resource payloads
      if (
        contentType.includes("text/html") || 
        contentType.includes("application/xhtml+xml") ||
        contentType.includes("text/css") ||
        contentType.includes("application/javascript") ||
        contentType.includes("application/x-javascript") ||
        contentType.startsWith("image/") ||
        contentType.startsWith("font/")
      ) {
        return;
      }

      // Intercept audio content types for video/audio pairing
      const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
      if (contentType.startsWith("audio/") || cleanUrlEndsWith(url, ".m4a") || cleanUrlEndsWith(url, ".aac") || cleanUrlEndsWith(url, ".mp3")) {
        if (!tabRecentAudios[tabId]) {
          tabRecentAudios[tabId] = [];
        }
        if (!tabRecentAudios[tabId].some(a => a.url === url)) {
          tabRecentAudios[tabId].push({
            url: url,
            contentType: contentType,
            timestamp: Date.now()
          });
          if (tabRecentAudios[tabId].length > 10) {
            tabRecentAudios[tabId].shift();
          }
          console.log(`[Detector] Logged recent audio for tab ${tabId}: ${url}`);
        }
        return;
      }

      // EXPLICITLY IGNORE HLS segment stream chunks (video/mp2t) to prevent flooding the list
      if (contentType.includes("video/mp2t") || cleanUrlEndsWith(url, ".ts")) {
        return;
      }
      const isManifest = contentType.includes("mpegurl") || contentType.includes("dash+xml") || cleanUrl.includes(".m3u8") || cleanUrl.includes(".mpd");
      const normalizedMediaUrl = isManifest ? url : normalizeRangedMediaUrl(url);
      const normalizedRangeUrl = normalizedMediaUrl !== url;
      const contentRangeHeader = responseHeaders.find(
        (h) => h.name.toLowerCase() === "content-range"
      );
      const contentRangeInfo = contentRangeHeader ? parseContentRange(contentRangeHeader.value) : null;
      const isPartialMedia = !isManifest && (statusCode === 206 || !!contentRangeInfo || hasRangeQueryParams(url));

      // Check Content-Length size constraint (must be at least 500 KB for direct media)
      const contentLengthHeader = responseHeaders.find(
        (h) => h.name.toLowerCase() === "content-length"
      );
      let sizeBytes = null;
      if (contentRangeInfo && contentRangeInfo.total) {
        sizeBytes = contentRangeInfo.total;
      }
      if (!isManifest) {
        let size = null;
        if (contentLengthHeader) {
          size = parseInt(contentLengthHeader.value);
        }
        const comparableSize = sizeBytes || size;
        if (comparableSize !== null && !isNaN(comparableSize)) {
          if (comparableSize < MIN_DIRECT_MEDIA_SIZE) {
            console.log(`[Detector] Skipping small network media (${comparableSize} bytes): ${url}`);
            return;
          }
          if (!sizeBytes) {
            sizeBytes = comparableSize;
          }
        } else {
          // If size is completely unknown, filter out obvious ad/promo/loop keywords
          const lowerUrl = url.toLowerCase();
          if (lowerUrl.includes("ad") || lowerUrl.includes("promo") || lowerUrl.includes("loop") || lowerUrl.includes("badge") || lowerUrl.includes("icon") || lowerUrl.includes("/ad/")) {
            console.log(`[Detector] Skipping ad/loop network media with unknown size: ${url}`);
            return;
          }
        }
      }

      let mediaType = null;
      let mediaTitle = "";

      // 1. Detect HLS & DASH streams by mime-type or manifest extensions
      if (contentType.includes("application/x-mpegurl") || contentType.includes("application/vnd.apple.mpegurl") || cleanUrl.includes(".m3u8")) {
        mediaType = "hls";
        mediaTitle = "HLS Video (Multi-Quality)";
      } else if (contentType.includes("application/dash+xml") || cleanUrl.includes(".mpd")) {
        mediaType = "dash";
        mediaTitle = "DASH Video (Adaptive Quality)";
      } 
      // 2. Detect direct videos by video/* mime-type
      else if (contentType.startsWith("video/")) {
        mediaType = contentType.split("/")[1];
        mediaTitle = `${mediaType.toUpperCase()} Video`;
      }
      // 3. Fallback: Extension matching for generic octet-stream/text/plain files
      else if (contentType.includes("octet-stream") || contentType.includes("text/plain")) {
        if (cleanUrl.endsWith(".mp4")) {
          mediaType = "mp4";
          mediaTitle = "MP4 Video";
        } else if (cleanUrl.endsWith(".webm")) {
          mediaType = "webm";
          mediaTitle = "WebM Video";
        } else if (cleanUrl.endsWith(".mkv")) {
          mediaType = "mkv";
          mediaTitle = "MKV Video";
        } else if (cleanUrl.endsWith(".flv")) {
          mediaType = "flv";
          mediaTitle = "FLV Video";
        } else if (cleanUrl.endsWith(".avi")) {
          mediaType = "avi";
          mediaTitle = "AVI Video";
        } else if (cleanUrl.endsWith(".mov")) {
          mediaType = "mov";
          mediaTitle = "MOV Video";
        } else if (cleanUrl.endsWith(".3gp")) {
          mediaType = "3gp";
          mediaTitle = "3GP Video";
        }
      }

      if (mediaType) {
        if (isPartialMedia && !normalizedRangeUrl && !contentRangeInfo) {
          console.log(`[Detector] Skipping partial media response without a full-file URL: ${url}`);
          return;
        }

        let bytestartVal = undefined;
        try {
          const urlObj = new URL(url);
          const bs = urlObj.searchParams.get("bytestart");
          if (bs) bytestartVal = parseInt(bs, 10);
        } catch (e) {}

        /* --- Instagram audio stream detection (disabled) ---
        // Instagram serves video and audio as separate video/mp4 CDN streams.
        // The audio stream has a DIFFERENT URL path from the video stream.
        // Detect it by checking if a differently-pathed Instagram CDN video/mp4 is
        // significantly smaller than an already-registered video on this tab.
        const isInstagramCdn = url.includes("cdninstagram.com") && (url.includes("bytestart=") || url.includes("byteend="));
        if (isInstagramCdn && mediaType === "mp4") {
          const registeredList = tabVideoRegistry.get(tabId) || [];
          const existingInstaVideo = registeredList.find(v =>
            v.url && v.url.includes("cdninstagram.com") && !v.audioUrl
          );
          if (existingInstaVideo) {
            // Compare URL paths — if they differ, the new one is likely the audio track
            let existingPath = "";
            let newPath = "";
            try { existingPath = new URL(existingInstaVideo.url).pathname; } catch (e) {}
            try { newPath = new URL(normalizedMediaUrl).pathname; } catch (e) {}
            const isDifferentStream = existingPath && newPath && existingPath !== newPath;
            // Accept it as audio if it's a different path (audio track) or noticeably smaller
            const newSize = sizeBytes || 0;
            const existingSize = existingInstaVideo.sizeBytes || 0;
            const isSmallerStream = existingSize > 0 && newSize > 0 && newSize < existingSize * 0.6;
            if (isDifferentStream || isSmallerStream) {
              console.log(`[Detector] Instagram CDN stream looks like audio track (different path or smaller). Storing for pairing. Video: ${existingInstaVideo.url}, Audio: ${normalizedMediaUrl}`);
              if (!tabRecentAudios[tabId]) tabRecentAudios[tabId] = [];
              if (!tabRecentAudios[tabId].some(a => a.url === normalizedMediaUrl)) {
                tabRecentAudios[tabId].push({ url: normalizedMediaUrl, contentType: "video/mp4", timestamp: Date.now() });
              }
              // Immediately pair with the existing registered video
              if (!existingInstaVideo.audioUrl) {
                existingInstaVideo.audioUrl = normalizedMediaUrl;
                existingInstaVideo.title = (existingInstaVideo.title || "Video").replace(" + Audio", "") + " + Audio";
                persistDebounced();
                chrome.runtime.sendMessage({ action: "video_registry_updated", tabId: tabId }).catch(() => {});
                console.log(`[Detector] Paired existing Instagram video with audio stream.`);
              }
              return; // Don't register as a separate video entry
            }
          }
        }
        --- End Instagram audio detection --- */

        registerVideo(tabId, {
          url: normalizedMediaUrl,
          type: mediaType,
          quality: "Network",
          resolution: mediaType === "hls" || mediaType === "dash" ? "Auto" : "Direct",
          title: mediaTitle,
          sizeBytes,
          bytestart: bytestartVal
        });
      }
    }
  },
  { 
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "object"]
  },
  ["responseHeaders"]
);

function cleanUrlEndsWith(url, ext) {
  const clean = url.split('?')[0].split('#')[0].toLowerCase();
  return clean.endsWith(ext);
}

function calculateUrlSimilarity(url1, url2) {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    if (u1.origin !== u2.origin) return -1;
    
    const p1 = u1.pathname.split('/');
    const p2 = u2.pathname.split('/');
    let matchCount = 0;
    for (let i = 0; i < Math.min(p1.length, p2.length); i++) {
      if (p1[i] === p2[i]) {
        matchCount++;
      } else {
        break;
      }
    }
    return matchCount;
  } catch (e) {
    return -1;
  }
}

function hasRangeQueryParams(urlStr) {
  try {
    const url = new URL(urlStr);
    return ["bytestart", "byteend", "range"].some((param) => url.searchParams.has(param));
  } catch (e) {
    return false;
  }
}

function normalizeRangedMediaUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    [
      "bytestart",
      "byteend",
      "range",
      "rn",
      "obufp",
      "index",
      "sq"
    ].forEach((param) => url.searchParams.delete(param));
    return url.href;
  } catch (e) {
    return urlStr;
  }
}

function parseContentRange(value) {
  const match = String(value).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!match) return null;

  return {
    start: parseInt(match[1], 10),
    end: parseInt(match[2], 10),
    total: match[3] === "*" ? null : parseInt(match[3], 10)
  };
}

function isPlayableDetectedVideo(video) {
  if (!video) return false;
  return !!video.url || video.type === "youtube" || video.type === "hls" || video.type === "dash";
}

// Limits memory growth by evicting oldest DOM-source video entries first
function pruneRegistry(tabId) {
  const MAX_REGISTRY_SIZE = 60;
  const list = tabVideoRegistry.get(tabId);
  if (!list || list.length <= MAX_REGISTRY_SIZE) return;
  
  const domEntries = list.filter(v => v.quality === "DOM");
  if (domEntries.length > 0) {
    const oldest = domEntries[0];
    tabVideoRegistry.set(tabId, list.filter(v => v !== oldest));
  } else {
    list.shift();
  }
}

async function probeSize(url) {
  const controller = new AbortController();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: controller.signal
    });
    let size = null;
    const contentRange = res.headers.get("content-range");
    if (contentRange) {
      const match = contentRange.match(/bytes\s+\d+-\d+\/(\d+)/i);
      if (match) size = parseInt(match[1], 10);
    }
    if (!size) {
      const len = res.headers.get("content-length");
      if (len) size = parseInt(len, 10);
    }
    controller.abort();
    return size;
  } catch (e) {
    controller.abort();
    // Try HEAD request as fallback
    try {
      const res = await fetch(url, { method: "HEAD" });
      const len = res.headers.get("content-length");
      if (len) return parseInt(len, 10);
    } catch (_) {}
    return null;
  }
}

// Registers the detected video, ensuring uniqueness and computing exact options count
function registerVideo(tabId, video) {
  if (!tabVideoRegistry.has(tabId)) {
    tabVideoRegistry.set(tabId, []);
  }

  // Instagram's Media panel entries are downloaded directly.  CDN responses
  // must not be paired heuristically into a separate-audio merge job.
  if (video.url && video.url.includes("cdninstagram.com")) {
    delete video.audioUrl;
  }

  if (video.bytestart === undefined && video.url) {
    try {
      const urlObj = new URL(video.url);
      const bs = urlObj.searchParams.get("bytestart");
      if (bs) video.bytestart = parseInt(bs, 10);
    } catch (e) {}
  }

  // Attempt to pair video with recently intercepted audio track
  if (video.type !== "youtube" && video.type !== "hls" && video.type !== "dash" && !video.audioUrl && video.url) {
    const recentAudios = tabRecentAudios[tabId] || [];
    const now = Date.now();
    const activeAudios = recentAudios.filter(a => now - a.timestamp < 30000);
    tabRecentAudios[tabId] = activeAudios; // keep registry pruned
    
    const isInstagramVideo = video.url && video.url.includes("cdninstagram.com");

    if (activeAudios.length > 0 && !isInstagramVideo) {
      let bestAudioUrl = null;
      let highestScore = -1;
      
      activeAudios.forEach((audio) => {
        let score = calculateUrlSimilarity(video.url, audio.url);
        // For Instagram CDN, same-origin streams with different paths are still valid audio pairs
        if (score < 1 && isInstagramVideo && audio.url.includes("cdninstagram.com")) {
          // Give a minimum score so they can be paired even with different paths
          score = 1;
        }
        if (score > highestScore) {
          highestScore = score;
          bestAudioUrl = audio.url;
        }
      });
      
      if (bestAudioUrl && highestScore >= 1) {
        video.audioUrl = bestAudioUrl;
        video.title = `${video.title || "Video"} + Audio`;
        console.log(`[Detector] Paired direct video-only link with audio track. Score: ${highestScore}. Video: ${video.url}, Audio: ${bestAudioUrl}`);
      }
    }

    // Instagram-specific: if this new video could be the AUDIO stream for an already-registered
    // Instagram video (audio arrives as a standalone video/mp4 before the real video), pair them.
    if (!isInstagramVideo && !video.audioUrl) {
      const registeredList = tabVideoRegistry.get(tabId) || [];
      const existingLarger = registeredList.find(v =>
        v.url &&
        v.url.includes("cdninstagram.com") &&
        !v.audioUrl &&
        v.url !== video.url &&
        (v.sizeBytes || 0) > (video.sizeBytes || 0) * 1.4
      );
      if (existingLarger) {
        existingLarger.audioUrl = video.url;
        existingLarger.title = (existingLarger.title || "Video").replace(" + Audio", "") + " + Audio";
        console.log(`[Detector] Retroactively paired existing Instagram video as video, new entry as audio. Audio: ${video.url}`);
        // Don't register the smaller stream as a separate video
        updateBadgeCount(tabId);
        persistDebounced();
        chrome.runtime.sendMessage({ action: "video_registry_updated", tabId: tabId }).catch(() => {});
        return;
      }
    }
  }

  if (video.type === "youtube") {
    const registryList = tabVideoRegistry.get(tabId);
    const idx = registryList.findIndex(v => v.type === "youtube");
    if (idx !== -1) {
      registryList[idx] = video;
    } else {
      pruneRegistry(tabId);
      registryList.push(video);
    }
    updateBadgeCount(tabId);
    persistDebounced();
    chrome.runtime.sendMessage({ action: "video_registry_updated", tabId: tabId }).catch(() => {});
    return;
  }

  if (video.url && video.type !== "hls" && video.type !== "dash") {
    video.url = normalizeRangedMediaUrl(video.url);
  }

  const isYoutube = (video.url && (video.url.includes("googlevideo.com/videoplayback") || video.url.includes("youtube.com/videoplayback"))) || video.type === "youtube_stream" || video.itag;
  const isManifest = video.type === "hls" || video.type === "dash" || (video.url && (video.url.includes(".m3u8") || video.url.includes(".mpd")));

  const doRegister = () => {

    let exists = false;
    let existingVideo = null;
    if (isYoutube) {
      const itag = video.itag || (video.url ? new URL(video.url).searchParams.get("itag") : null);
      existingVideo = tabVideoRegistry.get(tabId).find(v => {
        const vIsYoutube = (v.url && (v.url.includes("googlevideo.com/videoplayback") || v.url.includes("youtube.com/videoplayback"))) || v.type === "youtube_stream" || v.itag;
        if (vIsYoutube) {
          const vItag = v.itag || (v.url ? new URL(v.url).searchParams.get("itag") : null);
          return String(vItag) === String(itag);
        }
        return false;
      });
      exists = !!existingVideo;
    } else {
      const getCleanUrl = (url) => url.split('?')[0].split('#')[0];
      const videoCleanUrl = getCleanUrl(video.url);
      
      const getUrlPath = (urlStr) => {
        try {
          const urlObj = new URL(urlStr);
          return urlObj.pathname;
        } catch (e) {
          return urlStr;
        }
      };
      const videoPath = getUrlPath(video.url);

      const isGenericTitle = (t) => {
        const lower = String(t || "").toLowerCase();
        return !lower || 
          lower.includes("video stream") ||
          lower.includes("hls video") ||
          lower.includes("dash video") ||
          lower.includes("mp4 video") ||
          lower.includes("webm video") ||
          lower.includes("mkv video") ||
          lower.includes("youtube video") ||
          lower.includes("vimeo video") ||
          lower.includes("instagram video");
      };

      const getContentFingerprint = (v) => {
        if (isGenericTitle(v.title)) return null;
        return `${v.title || ''}|${v.resolution || ''}|${v.type || ''}`.toLowerCase();
      };
      
      const videoFingerprint = getContentFingerprint(video);
      
      existingVideo = tabVideoRegistry.get(tabId).find(v => {
        if (getCleanUrl(v.url) === videoCleanUrl) return true;
        
        const vPath = getUrlPath(v.url);
        if (videoPath && videoPath.length > 5 && videoPath === vPath) {
          return true;
        }
        
        const vFingerprint = getContentFingerprint(v);
        if (videoFingerprint && vFingerprint && videoFingerprint === vFingerprint) {
          return true;
        }
        
        // Match Instagram videos by caption (pageTitle) to find duplicate qualities
        const isNewInstagram = video.url && video.url.includes("cdninstagram.com");
        const vIsInstagram = v.url && v.url.includes("cdninstagram.com");
        if (isNewInstagram && vIsInstagram && video.pageTitle && video.pageTitle !== "Video Stream") {
          return v.pageTitle === video.pageTitle;
        }
        
        return false;
      });
      exists = !!existingVideo;
    }

    chrome.tabs.get(tabId, async (tab) => {
      let tabUrl = null;
      let tabTitle = "Video Stream";
      if (chrome.runtime.lastError || !tab) {
        console.warn("[Detector] Failed to get tab info during registerVideo for tabId:", tabId, "using fallbacks.");
      } else {
        tabUrl = tab.url;
        tabTitle = tab.title || "Video Stream";
      }
      
      const currentTitle = video.instagramDescription || tabTitle;

      if (!exists) {
        const ruleUrl = video.frameUrl || tabUrl;
        if (ruleUrl) {
          await registerDnrRulesForDownload(tabId, ruleUrl);
        }
        
        // If it's YouTube, normalize properties using YOUTUBE_ITAGS
        if (isYoutube) {
          const itag = video.itag || (video.url ? new URL(video.url).searchParams.get("itag") : null);
          if (itag) {
            const itagInt = parseInt(itag);
            const itagInfo = YOUTUBE_ITAGS[itagInt];
            if (itagInfo) {
              video.type = itagInfo.type;
              video.quality = "YouTube";
              video.resolution = itagInfo.resolution;
              video.title = itagInfo.title;
              video.itag = itagInt;
              video.hasAudio = !!itagInfo.hasAudio;
              video.hasVideo = !!itagInfo.hasVideo;
              if (!video.hasAudio || !video.hasVideo) {
                console.log(`[Detector] Ignoring YouTube adaptive stream without both audio and video. itag=${itagInt}`);
                return;
              }
              if (video.url) {
                video.url = cleanYoutubeUrl(video.url);
              }
            }
          }
        }

        video.pageTitle = currentTitle;
        
        // Fetch HLS qualities in background immediately to calculate options count
        if (video.type === "hls") {
          try {
            console.log("[Detector] Parsing HLS qualities in background...");
            const qualities = await parseM3U8(video.url, tabId, video.frameId);
            video.qualities = qualities || [];
            video.isHlsMaster = video.qualities.length > 0;
            video.hasSeparateAudio = video.qualities.some((quality) => !!quality.audioUrl);
          } catch (e) {
            console.error(`[Detector] HLS parse failed for ${video.url}:`, e.message);
            video.qualities = [];
            video.isHlsMaster = false;
            video.hasSeparateAudio = false;
            video.parseError = e.message;
          }

          if (video.isHlsMaster) {
            const list = tabVideoRegistry.get(tabId);
            const beforeCount = list.length;
            const filtered = list.filter((v) => {
              return v.type !== "hls" || (v.qualities && v.qualities.length > 0);
            });
            tabVideoRegistry.set(tabId, filtered);
            if (filtered.length !== beforeCount) {
              console.log("[Detector] Replaced video-only HLS media playlists with master HLS playlist.");
            }
          } else {
            const hasMasterHls = tabVideoRegistry.get(tabId).some((v) => {
              return v.type === "hls" && v.qualities && v.qualities.length > 0;
            });
            if (hasMasterHls) {
              console.log(`[Detector] Ignoring HLS media playlist because a master playlist is already registered: ${video.url}`);
              updateBadgeCount(tabId);
              return;
            }
          }
        }

        pruneRegistry(tabId);
        tabVideoRegistry.get(tabId).push(video);
        console.log(`[Detector] Video registered for Tab ${tabId}: ${video.url}`);
        
        updateBadgeCount(tabId);
        persistDebounced();

        if (tabUrl && video.type !== "youtube" && video.type !== "spotify" && video.type !== "ytdlp") {
          checkYtdlpSupportInBackground(tabId, tabUrl, currentTitle);
        }
      } else if (existingVideo) {
        let enriched = false;
        
        // For Instagram quality selection: only overwrite if new video has a larger size (higher quality)
        const isInstagramMatch = video.url && video.url.includes("cdninstagram.com") && 
                                 existingVideo.url && existingVideo.url.includes("cdninstagram.com");
        
        if (isInstagramMatch) {
          // Clear pairings created by older heuristic detection runs.
          if (existingVideo.audioUrl) {
            delete existingVideo.audioUrl;
            enriched = true;
          }
          const newSize = video.sizeBytes || 0;
          const oldSize = existingVideo.sizeBytes || 0;
          if (newSize > oldSize) {
            existingVideo.url = video.url;
            existingVideo.sizeBytes = video.sizeBytes;
            existingVideo.thumbnail = video.thumbnail || existingVideo.thumbnail;
            enriched = true;
            console.log(`[Detector] Replaced low quality Instagram video (${oldSize} bytes) with high quality (${newSize} bytes)`);
          }
        } else {
          // Standard enrichment for other videos
          if (video.thumbnail && !existingVideo.thumbnail) {
            existingVideo.thumbnail = video.thumbnail;
            enriched = true;
          }
          if (video.sizeBytes && !existingVideo.sizeBytes) {
            existingVideo.sizeBytes = video.sizeBytes;
            enriched = true;
          }
          if (video.audioUrl && !existingVideo.audioUrl) {
            existingVideo.audioUrl = video.audioUrl;
            enriched = true;
          }
        }
        
        if (video.instagramDescription && existingVideo.pageTitle !== video.instagramDescription) {
          existingVideo.pageTitle = video.instagramDescription;
          enriched = true;
        }
        
        // Reel preloading shift fix: if this is a subsequent chunk fetch, it means it is playing,
        // so we update its title to the current tab title/caption!
        const isInstagramUrl = (video.url && video.url.includes("cdninstagram.com")) || (existingVideo.url && existingVideo.url.includes("cdninstagram.com"));
        if (isInstagramUrl && video.bytestart !== undefined && video.bytestart > 0) {
          if (existingVideo.pageTitle !== currentTitle) {
            existingVideo.pageTitle = currentTitle;
            enriched = true;
            console.log(`[Detector] Updated preloaded Reel title to current tab title: ${currentTitle}`);
          }
        }

        if (enriched) {
          console.log(`[Detector] Enriched existing video metadata: ${video.url}`);
          updateBadgeCount(tabId);
          persistDebounced();
        }
      }
    });
  };

  // If it's a DOM-detected direct video, check its size first
  if (video.quality === "DOM" && !isYoutube && !isManifest && video.url) {
    probeSize(video.url)
      .then((size) => {
        if (size !== null && !isNaN(size)) {
          if (size < MIN_DIRECT_MEDIA_SIZE) {
            console.log(`[Detector] Skipping small DOM media (${size} bytes): ${video.url}`);
            return;
          }
          video.sizeBytes = size;
        } else {
          // If size is completely unknown, filter out obvious ad/promo/loop keywords to avoid junk cards
          const lowerUrl = video.url.toLowerCase();
          if (lowerUrl.includes("ad") || lowerUrl.includes("promo") || lowerUrl.includes("loop") || lowerUrl.includes("badge") || lowerUrl.includes("icon") || lowerUrl.includes("/ad/")) {
            console.log(`[Detector] Skipping DOM media ad/loop with unknown size: ${video.url}`);
            return;
          }
        }
        doRegister();
      })
      .catch(() => {
        // Fallback: register anyway if probe throws
        doRegister();
      });
  } else {
    doRegister();
  }
}

// Recalculates total downloading options available and updates badge text
function updateBadgeCount(tabId) {
  const registry = (tabVideoRegistry.get(tabId) || []).filter(isPlayableDetectedVideo);
  let totalOptions = 0;
  
  registry.forEach((v) => {
    if (v.type === "hls") {
      totalOptions += (v.qualities && v.qualities.length > 0) ? v.qualities.length : 1;
    } else {
      totalOptions += 1;
    }
  });

  chrome.action.setBadgeText({ tabId, text: String(totalOptions) });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const activeTabId = sender.tab ? sender.tab.id : (message.tabId || null);
  if (activeTabId) {
    markTabAsActive(activeTabId);
  }

  if (message.action === "proxy_fetch_response") {
    chrome.runtime.sendMessage(message).catch(() => {});
    return false;
  }

  if (message.action === "background_proxy_fetch") {
    const options = {};
    if (typeof message.frameId === "number") {
      options.frameId = message.frameId;
    }
    chrome.tabs.sendMessage(message.tabId, {
      action: "proxy_fetch",
      url: message.url,
      options: message.options,
      responseType: message.responseType,
      requestId: message.requestId
    }, options, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response);
      }
    });
    return true; // Keep message channel open
  }

  const tabId = sender.tab ? sender.tab.id : null;

  if (message.action === "start_backend") {
    if (nativePort) {
      sendResponse({ success: true, running: true });
      return;
    }
    
    try {
      console.log("[Background] Attempting to connect to native backend...");
      nativePort = chrome.runtime.connectNative("com.unvdownloader.backend");
      
      let disconnected = false;
      let responseSent = false;

      nativePort.onMessage.addListener((msg) => {
        console.log("[Background] Native backend message:", msg);
      });
      
      nativePort.onDisconnect.addListener(() => {
        const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Disconnected immediately";
        console.log("[Background] Native backend disconnected. Last error:", errMsg);
        nativePort = null;
        disconnected = true;
        
        if (!responseSent) {
          responseSent = true;
          sendResponse({ success: false, error: errMsg });
        }
        chrome.runtime.sendMessage({ action: "backend_status_changed", running: false }).catch(() => {});
      });
      
      // Wait for Express server to boot up and verify via fetch polling
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        if (disconnected) {
          clearInterval(checkInterval);
          return;
        }
        
        fetch("http://localhost:3000/api/ping")
          .then(res => {
            if (res.ok) {
              clearInterval(checkInterval);
              if (!responseSent) {
                responseSent = true;
                sendResponse({ success: true, running: true });
              }
              chrome.runtime.sendMessage({ action: "backend_status_changed", running: true }).catch(() => {});
            }
          })
          .catch(() => {
            if (attempts > 8) { // 8 attempts * 500ms = 4 seconds timeout
              clearInterval(checkInterval);
              if (!responseSent) {
                responseSent = true;
                // If it's taking longer but port is still open, assume success
                sendResponse({ success: nativePort !== null, running: nativePort !== null });
              }
            }
          });
      }, 500);
      
      return true; // Keep channel open for async response
    } catch (e) {
      console.error("[Background] Failed to connect to native backend:", e);
      nativePort = null;
      sendResponse({ success: false, error: e.message });
    }
    
  } else if (message.action === "stop_backend") {
    if (nativePort) {
      console.log("[Background] Stopping native backend...");
      nativePort.disconnect();
      nativePort = null;
    }
    chrome.runtime.sendMessage({ action: "backend_status_changed", running: false }).catch(() => {});
    sendResponse({ success: true, running: false });
    
  } else if (message.action === "get_backend_status") {
    fetch("http://localhost:3000/api/ping")
      .then(res => {
        sendResponse({ running: res.ok });
      })
      .catch(() => {
        sendResponse({ running: nativePort !== null });
      });
    return true; // async
  }

  if (message.action === "clear_video_registry") {
    if (tabId) {
      console.log(`[Detector] Tab ${tabId} requested registry clear (reload).`);
      tabVideoRegistry.set(tabId, []);
      delete tabYoutubeMediaState[tabId];
      unregisterDnrRulesForDownload(tabId);
      chrome.action.setBadgeText({ tabId, text: "" });
      persistDebounced();
      chrome.runtime.sendMessage({ action: "video_registry_cleared", tabId: tabId }).catch(() => {});
    }
    sendResponse({ success: true });
  } else if (message.action === "register_youtube_format") {
    console.log("[Background Message] Received register_youtube_format. Format:", message.format);
    if (tabId) {
      processYoutubeMedia(tabId, message.format, message.format.title);
    }
    sendResponse({ success: true });
  } else if (message.action === "register_detected_video") {
    // Media URL detected via DOM/MutationObserver or API hook
    if (tabId) {
      if (sender.url) {
        message.video.frameUrl = sender.url;
      }
      if (typeof sender.frameId !== "undefined") {
        message.video.frameId = sender.frameId;
      }
      registerVideo(tabId, message.video);
    }
  } else if (message.action === "unregister_detected_video") {
    if (tabId && message.url) {
      const list = tabVideoRegistry.get(tabId);
      if (list) {
        const beforeCount = list.length;
        const cleanUrl = message.url.split('?')[0].split('#')[0].toLowerCase();
        const filtered = list.filter(v => {
          const vCleanUrl = v.url.split('?')[0].split('#')[0].toLowerCase();
          return vCleanUrl !== cleanUrl;
        });
        tabVideoRegistry.set(tabId, filtered);
        if (filtered.length !== beforeCount) {
          console.log(`[Detector] Unregistered video due to DOM removal: ${message.url}`);
          updateBadgeCount(tabId);
          persistDebounced();
          chrome.runtime.sendMessage({ action: "video_registry_updated", tabId: tabId }).catch(() => {});
        }
      }
    }
    sendResponse({ success: true });
  } else if (message.action === "register_ytdlp_card") {
    const { tabId, card } = message;
    if (tabId && card) {
      if (!tabVideoRegistry.has(tabId)) {
        tabVideoRegistry.set(tabId, []);
      }
      const list = tabVideoRegistry.get(tabId);
      if (!list.some(v => v.type === card.type)) {
        list.push(card);
        updateBadgeCount(tabId);
        persistDebounced();
      }
    }
    sendResponse({ success: true });
  } else if (message.action === "get_detected_videos") {
    // Popup requesting detected list
    const targetTabId = message.tabId || (sender.tab ? sender.tab.id : null);
    if (targetTabId) {
      chrome.tabs.get(targetTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          const videos = (tabVideoRegistry.get(targetTabId) || []).filter(isPlayableDetectedVideo);
          sendResponse({ videos });
          return;
        }

        const url = tab.url || "";
        const isYoutubeWatchPage = url.includes("youtube.com/watch") || url.includes("youtu.be/");
        
        if (isYoutubeWatchPage) {
          if (!tabVideoRegistry.has(targetTabId)) {
            tabVideoRegistry.set(targetTabId, []);
          }
          const registry = tabVideoRegistry.get(targetTabId);
          const hasYoutubeCard = registry.some(v => v.type === "youtube");
          
          if (!hasYoutubeCard) {
            console.log(`[Background] Auto-injecting YouTube card for active watch tab: ${url}`);
            let videoId = null;
            try {
              const urlObj = new URL(url);
              videoId = urlObj.searchParams.get("v");
              if (!videoId && url.includes("youtu.be/")) {
                videoId = urlObj.pathname.slice(1).split("/")[0];
              }
            } catch (e) {}

            const thumbnail = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;
            const title = tab.title || "YouTube Video";
            
            const dummyVideo = {
              url: url,
              type: "youtube",
              quality: "YouTube",
              resolution: "Multi Quality",
              title: title,
              thumbnail: thumbnail,
              qualities: [], // Popup will render standard yt-dlp qualities
              pageTitle: title
            };

            tabYoutubeMediaState[targetTabId] = {
              videoId: videoId,
              title: title,
              thumbnail: thumbnail,
              videoUrls: {},
              audioUrls: {}
            };

            registry.push(dummyVideo);
            updateBadgeCount(targetTabId);
            persistDebounced();
          }
        }

        const videos = (tabVideoRegistry.get(targetTabId) || []).filter(isPlayableDetectedVideo);
        sendResponse({ videos });
      });
      return true; // Keep message channel open
    } else {
      sendResponse({ videos: [] });
    }
  } else if (message.action === "get_download_progress") {
    // Popup requesting active download state
    const info = activeDownloads[message.tabId];
    if (info) {
      sendResponse({ downloading: true, progress: info.progress });
    } else {
      sendResponse({ downloading: false });
    }
  } else if (message.action === "start_hls_download") {
    // Delegate HLS download to offscreen document
    handleHlsDownload(message.tabId, message.url, message.qualityTitle, message.frameId);
    sendResponse({ success: true });
  } else if (message.action === "start_combined_media_download") {
    // Delegate combined media download to offscreen document
    handleCombinedMediaDownload(message.tabId, message.videoUrl, message.audioUrl, message.pageTitle, message.frameId);
    sendResponse({ success: true });
  } else if (message.action === "start_direct_download") {
    // Delegate direct media download to offscreen document
    handleDirectDownload(message.tabId, message.url, message.pageTitle, message.expectedSize, message.frameId);
    sendResponse({ success: true });
  } else if (message.action === "start_youtube_download") {
    // Delegate YouTube video download to offscreen document
    handleYoutubeDownload(message.tabId, message.videoUrl, message.audioUrl, message.pageTitle, message.resolution, message.frameId, message.youtubeUrl);
    sendResponse({ success: true });
  } else if (message.action === "start_spotify_download") {
    // Delegate Spotify track download to offscreen document
    handleSpotifyDownload(message.tabId, message.spotifyUrl, message.pageTitle, message.quality);
    sendResponse({ success: true });
  } else if (message.action === "cancel_hls_download") {
    // Cancel download in offscreen document
    chrome.runtime.sendMessage({
      action: "cancel_offscreen_hls_download",
      tabId: message.tabId
    }).catch(() => {});
    delete activeDownloads[message.tabId];
    closeOffscreenDocument();
    sendResponse({ success: true });
  } else if (message.action === "download_progress_update") {
    // Save progress updates in background state
    if (activeDownloads[message.tabId]) {
      activeDownloads[message.tabId].progress = message.progress;
    }
  } else if (message.action === "offscreen_download_complete") {
    // Download successfully triggered in offscreen context, perform cleanup
    delete activeDownloads[message.tabId];
    closeOffscreenDocument();
  } else if (message.action === "download_error") {
    // Download errored, clean up
    delete activeDownloads[message.tabId];
    closeOffscreenDocument();
  } else if (message.action === "unregister_dnr_rules") {
    unregisterDnrRulesForDownload(message.tabId).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (message.action === "register_dnr_rules_for_tab") {
    const pageUrl = dnrUrlRegistry[message.tabId];
    if (pageUrl) {
      registerDnrRulesForDownload(message.tabId, pageUrl).then(() => {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false, error: "No pageUrl registered for tab" });
    }
    return true;
  }
  return true;
});

// Cleans up memory when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideoRegistry.delete(tabId);
  lastTabUrls.delete(tabId);
  dnrUrlRegistry.delete(tabId);
  delete tabYoutubeMediaState[tabId];
  delete tabRecentAudios[tabId];
  
  // Clean up activity tracking timers/sets to prevent memory leaks
  recentlyActiveTabIds.delete(tabId);
  if (activeTabTimeouts.has(tabId)) {
    clearTimeout(activeTabTimeouts.get(tabId));
    activeTabTimeouts.delete(tabId);
  }

  unregisterDnrRulesForDownload(tabId);
  persistDebounced();
  if (activeDownloads[tabId]) {
    chrome.runtime.sendMessage({
      action: "cancel_offscreen_hls_download",
      tabId: tabId
    }).catch(() => {});
    delete activeDownloads[tabId];
    closeOffscreenDocument();
  }
});

// Clear tab registry when navigating to a new URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    let oldUrl = lastTabUrls.get(tabId);
    const newUrl = changeInfo.url;
    lastTabUrls.set(tabId, newUrl);
    
    if (!oldUrl && tabVideoRegistry.has(tabId) && tabVideoRegistry.get(tabId).length > 0) {
      oldUrl = tabVideoRegistry.get(tabId)[0].pageUrl || tabVideoRegistry.get(tabId)[0].url;
    }

    if (oldUrl) {
      try {
        const oldObj = new URL(oldUrl);
        const newObj = new URL(newUrl);
        
        // If same origin and pathname, it's a minor change (query parameters, hash, etc.) -> DO NOT clear registry!
        if (oldObj.origin === newObj.origin && oldObj.pathname === newObj.pathname) {
          console.log(`[Detector] Tab ${tabId} minor URL update (${newUrl}). Keeping registry.`);
          persistDebounced();
          return;
        }
      } catch (e) {}
    }

    // Otherwise, it's a substantial URL change: clear registry
    console.log(`[Detector] Tab ${tabId} navigated to new path: ${newUrl}. Clearing registry.`);
    tabVideoRegistry.set(tabId, []);
    delete tabYoutubeMediaState[tabId];
    delete tabRecentAudios[tabId];
    unregisterDnrRulesForDownload(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
    persistDebounced();
    chrome.runtime.sendMessage({ action: "video_registry_cleared", tabId: tabId }).catch(() => {});
  }

  // Check support on page load complete
  if (changeInfo.status === "complete" && tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("about:") && !tab.url.startsWith("chrome-extension://")) {
    checkYtdlpSupportInBackground(tabId, tab.url, tab.title);
  }
});

async function checkYtdlpSupportInBackground(tabId, url, title) {
  const isSpotify = url.includes("spotify.com");
  const isYoutube = url.includes("youtube.com") || url.includes("youtu.be");
  
  if (isSpotify || isYoutube) {
    return;
  }
  
  try {
    const checkUrl = `http://localhost:3000/api/youtube-formats?url=${encodeURIComponent(url)}`;
    const res = await fetch(checkUrl);
    if (!res.ok) return;
    const data = await res.json();
    
    if (data && data.qualities && data.qualities.length > 0) {
      if (!tabVideoRegistry.has(tabId)) {
        tabVideoRegistry.set(tabId, []);
      }
      
      if (!tabVideoRegistry.get(tabId).some(v => v.type === "ytdlp")) {
        let siteName = "Media Page";
        try {
          const match = url.match(/https?:\/\/(?:www\.)?([^/]+)/i);
          if (match && match[1]) {
            siteName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
          }
        } catch(e) {}
        
        const ytdlpCard = {
          url: url,
          type: "ytdlp",
          quality: "yt-dlp",
          resolution: "Multi Quality",
          title: title || "Web Video",
          pageTitle: title || "Web Video",
          siteName: siteName,
          qualities: data.qualities
        };
        
        tabVideoRegistry.get(tabId).push(ytdlpCard);
        updateBadgeCount(tabId);
        persistDebounced();
        chrome.runtime.sendMessage({ action: "video_registry_updated", tabId: tabId }).catch(() => {});
        console.log(`[Background Check] Registered supported URL with ${data.qualities.length} pre-fetched qualities: ${url}`);
      }
    }
  } catch (err) {
    console.warn(`[Background Check] Failed to check support and fetch qualities for ${url}:`, err);
  }
}

let offscreenIdleTimer = null;

// Sets up and creates the offscreen document if it doesn't already exist
async function setupOffscreenDocument(path) {
  if (offscreenIdleTimer) {
    clearTimeout(offscreenIdleTimer);
    offscreenIdleTimer = null;
    console.log("[Detector] Cleared offscreen document idle timer.");
  }
  
  try {
    if (chrome.offscreen.hasDocument) {
      const existing = await chrome.offscreen.hasDocument();
      if (existing) {
        console.log("[Detector] Offscreen document already exists.");
        return;
      }
    }
  } catch (e) {
    console.warn("[Detector] Failed to check for existing offscreen document:", e);
  }

  try {
    await chrome.offscreen.createDocument({
      url: path,
      reasons: ['BLOBS'],
      justification: 'For buffer operations and URL creation'
    });
    console.log("[Detector] Created offscreen document.");
  } catch (e) {
    if (!e.message.includes("Only one offscreen document")) {
      throw e;
    }
  }
}

// Closes the offscreen document if there are no active downloads, using an idle timeout
async function closeOffscreenDocument() {
  if (Object.keys(activeDownloads).length === 0) {
    if (offscreenIdleTimer) {
      clearTimeout(offscreenIdleTimer);
    }
    
    console.log("[Detector] Starting 30 seconds idle timeout for offscreen document.");
    offscreenIdleTimer = setTimeout(async () => {
      offscreenIdleTimer = null;
      if (Object.keys(activeDownloads).length === 0) {
        try {
          await chrome.offscreen.closeDocument();
          console.log("[Detector] Closed offscreen document after idle timeout.");
        } catch (e) {
          // Ignore if already closed
        }
      }
    }, 30000);
  }
}

// Delegates sequential segment fetching to the offscreen DOM context
function getFrameUrlForVideo(tabId, url) {
  const registry = tabVideoRegistry.get(tabId) || [];
  const getCleanUrl = (u) => u ? u.split('?')[0].split('#')[0] : '';
  const cleanUrl = getCleanUrl(url);
  const video = registry.find(v => {
    if (getCleanUrl(v.url) === cleanUrl) return true;
    if (v.qualities && v.qualities.some(q => getCleanUrl(q.url) === cleanUrl)) return true;
    return false;
  });
  return video?.frameUrl || null;
}

// Delegates sequential segment fetching to the offscreen DOM context
async function handleHlsDownload(tabId, m3u8Url, qualityTitle, frameId) {
  console.log(`[Downloader] Delegating HLS Download for tab ${tabId} to Offscreen Document.`);
  
  // Store initial download state
  activeDownloads[tabId] = { url: m3u8Url, qualityTitle, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    const tab = await chrome.tabs.get(tabId);
    const pageTitle = (tab && tab.title) ? tab.title : "hls_video";
    
    const frameUrl = getFrameUrlForVideo(tabId, m3u8Url) || tab?.url;
    if (frameUrl) {
      await registerDnrRulesForDownload(tabId, frameUrl, m3u8Url);
    }
    
    await chrome.runtime.sendMessage({
      action: "start_offscreen_hls_download",
      tabId: tabId,
      url: m3u8Url,
      qualityTitle: qualityTitle,
      pageTitle: pageTitle,
      frameId: frameId
    });

  } catch (error) {
    console.error(`[Downloader] Setup failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
    closeOffscreenDocument();
  }
}

async function handleCombinedMediaDownload(tabId, videoUrl, audioUrl, pageTitle, frameId) {
  console.log(`[Downloader] Delegating Combined Download for tab ${tabId} to Offscreen Document.`);
  
  activeDownloads[tabId] = { url: videoUrl, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    const tab = await chrome.tabs.get(tabId);
    const title = pageTitle || ((tab && tab.title) ? tab.title : "combined_video");
    
    const frameUrl = getFrameUrlForVideo(tabId, videoUrl) || tab?.url;
    if (frameUrl) {
      await registerDnrRulesForDownload(tabId, frameUrl, videoUrl);
    }
    
    await chrome.runtime.sendMessage({
      action: "start_combined_media_download",
      tabId: tabId,
      videoUrl: videoUrl,
      audioUrl: audioUrl,
      pageTitle: title,
      frameId: frameId
    });

  } catch (error) {
    console.error(`[Downloader] Combined download setup failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
    closeOffscreenDocument();
  }
}

async function handleDirectDownload(tabId, url, pageTitle, expectedSize, frameId) {
  console.log(`[Downloader] Delegating Direct Download for tab ${tabId} to Offscreen Document.`);
  
  activeDownloads[tabId] = { url: url, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    const tab = await chrome.tabs.get(tabId);
    const title = pageTitle || ((tab && tab.title) ? tab.title : "video");
    
    const frameUrl = getFrameUrlForVideo(tabId, url) || tab?.url;
    if (frameUrl) {
      await registerDnrRulesForDownload(tabId, frameUrl, url);
    }
    
    await chrome.runtime.sendMessage({
      action: "start_offscreen_direct_download",
      tabId: tabId,
      url: url,
      pageTitle: title,
      expectedSize: expectedSize,
      frameId: frameId
    });

  } catch (error) {
    console.error(`[Downloader] Direct download setup failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
    closeOffscreenDocument();
  }
}

async function handleYoutubeDownload(tabId, videoUrl, audioUrl, pageTitle, resolution, frameId, youtubeUrl = null) {
  console.log(`[Downloader] Delegating YouTube Download for tab ${tabId} to Offscreen Document. Custom URL: ${youtubeUrl}`);
  
  activeDownloads[tabId] = { videoUrl, audioUrl, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    const tab = await chrome.tabs.get(tabId);
    const title = pageTitle || ((tab && tab.title) ? tab.title : "youtube_video");
    
    const targetUrl = youtubeUrl || getFrameUrlForVideo(tabId, videoUrl) || tab?.url || null;
    if (targetUrl) {
      await registerDnrRulesForDownload(tabId, targetUrl);
    }
    
    await chrome.runtime.sendMessage({
      action: "start_offscreen_youtube_download",
      tabId: tabId,
      videoUrl: videoUrl,
      audioUrl: audioUrl,
      youtubeUrl: targetUrl,
      pageTitle: title,
      resolution: resolution,
      frameId: frameId
    });

  } catch (error) {
    console.error(`[Downloader] YouTube download setup failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
    closeOffscreenDocument();
  }
}

async function handleSpotifyDownload(tabId, spotifyUrl, pageTitle, quality) {
  console.log(`[Downloader] Delegating Spotify Download for tab ${tabId} to Offscreen Document. URL: ${spotifyUrl}`);
  
  activeDownloads[tabId] = { videoUrl: spotifyUrl, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    const tab = await chrome.tabs.get(tabId);
    const title = pageTitle || ((tab && tab.title) ? tab.title : "spotify_track");
    
    await registerDnrRulesForDownload(tabId, spotifyUrl);
    
    await chrome.runtime.sendMessage({
      action: "start_offscreen_spotify_download",
      tabId: tabId,
      spotifyUrl: spotifyUrl,
      pageTitle: title,
      quality: quality
    });

  } catch (error) {
    console.error(`[Downloader] Spotify download setup failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
    closeOffscreenDocument();
  }
}
