import { parseM3U8 } from './hls-parser.js';

const MIN_DIRECT_MEDIA_SIZE = 100 * 1024; // 100KB — allows small files and clips, filters out tracking assets

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
let tabVideoRegistry = {};

async function loadRegistryFromStorage() {
  try {
    const stored = await chrome.storage.session.get("tabVideoRegistry");
    if (stored && stored.tabVideoRegistry) {
      tabVideoRegistry = stored.tabVideoRegistry;
      console.log("[Background] Restored tabVideoRegistry from session storage:", Object.keys(tabVideoRegistry).length, "tabs");
    }
  } catch (e) {
    console.error("[Background] Failed to load registry from session storage:", e);
  }
}

// Simple debounce helper
function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const persistRegistry = async () => {
  try {
    await chrome.storage.session.set({ tabVideoRegistry });
  } catch (e) {
    console.error("[Background] Failed to persist registry to session storage:", e);
  }
};

const persistDebounced = debounce(persistRegistry, 500);

// Initialize registry load immediately
loadRegistryFromStorage();

// Active HLS downloads: tabId -> { url, qualityTitle, progress }
const activeDownloads = {};

let creatingOffscreen; // Global promise for offscreen lifecycle
const dnrUrlRegistry = {}; // tabId -> pageUrl
const tabRecentAudios = {}; // tabId -> Array of { url, contentType, timestamp }

console.log("[Detector] Service Worker initialized.");

// Register declarativeNetRequest rules to inject Origin/Referer headers for the extension's fetches
async function registerDnrRulesForDownload(tabId, pageUrl) {
  if (!chrome.declarativeNetRequest) {
    console.warn("[DNR] declarativeNetRequest API not available.");
    return;
  }
  
  if (!pageUrl || (!pageUrl.startsWith("http://") && !pageUrl.startsWith("https://"))) {
    return;
  }
  
  dnrUrlRegistry[tabId] = pageUrl;
  
  try {
    const urlObj = new URL(pageUrl);
    const origin = urlObj.origin;
    
    const rules = [
      {
        id: tabId,
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
          resourceTypes: ['xmlhttprequest']
        }
      }
    ];
    
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId],
      addRules: rules
    });
    
    // Verify it actually stuck
    const active = await chrome.declarativeNetRequest.getSessionRules();
    const confirmed = active.some(r => r.id === tabId);
    if (!confirmed) {
      console.warn(`[DNR] Rule for tab ${tabId} did not confirm active, retrying once...`);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [tabId],
        addRules: rules
      });
    }
    console.log(`[DNR] Registered and confirmed headers rules for Tab ${tabId}. Referer: ${pageUrl}, Origin: ${origin}`);
  } catch (e) {
    console.error("[DNR] Failed to register declarativeNetRequest rules:", e);
  }
}

async function unregisterDnrRulesForDownload(tabId) {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [tabId]
    });
    console.log(`[DNR] Unregistered headers rules for Tab ${tabId}`);
  } catch (e) {
    console.error("[DNR] Failed to unregister rules:", e);
  }
}

const tabYoutubeMediaState = {};

function processYoutubeMedia(tabId, item, pageTitle) {
  console.log(`[Background] processYoutubeMedia called for tab ${tabId}. itag: ${item.itag}, videoId: ${item.videoId}, url: ${item.url ? item.url.substring(0, 120) : "none"}`);
  
  if (!tabYoutubeMediaState[tabId] || (item.videoId && tabYoutubeMediaState[tabId].videoId !== item.videoId)) {
    console.log(`[Background] New YouTube video detected (videoId: ${item.videoId}). Resetting media state for Tab ${tabId}.`);
    if (tabVideoRegistry[tabId]) {
      tabVideoRegistry[tabId] = tabVideoRegistry[tabId].filter(v => v.type !== "youtube");
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
      if (contentLengthHeader && !isManifest) {
        const size = parseInt(contentLengthHeader.value);
        const comparableSize = sizeBytes || size;
        const isInstagram = url.includes("cdninstagram.com");
        if (!isInstagram && !isNaN(comparableSize) && comparableSize < MIN_DIRECT_MEDIA_SIZE) {
          console.log(`[Detector] Skipping small network media (${comparableSize} bytes): ${url}`);
          return;
        }
        if (!sizeBytes && !isNaN(size)) {
          sizeBytes = size;
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
  { urls: ["<all_urls>"] },
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
  if (!tabVideoRegistry[tabId] || tabVideoRegistry[tabId].length <= MAX_REGISTRY_SIZE) return;
  
  const domEntries = tabVideoRegistry[tabId].filter(v => v.quality === "DOM");
  if (domEntries.length > 0) {
    const oldest = domEntries[0];
    tabVideoRegistry[tabId] = tabVideoRegistry[tabId].filter(v => v !== oldest);
  } else {
    tabVideoRegistry[tabId].shift();
  }
}

// Registers the detected video, ensuring uniqueness and computing exact options count
function registerVideo(tabId, video) {
  if (!tabVideoRegistry[tabId]) {
    tabVideoRegistry[tabId] = [];
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
    
    if (activeAudios.length > 0) {
      let bestAudioUrl = null;
      let highestScore = -1;
      
      activeAudios.forEach((audio) => {
        const score = calculateUrlSimilarity(video.url, audio.url);
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
  }

  if (video.type === "youtube") {
    const idx = tabVideoRegistry[tabId].findIndex(v => v.type === "youtube");
    if (idx !== -1) {
      tabVideoRegistry[tabId][idx] = video;
    } else {
      pruneRegistry(tabId);
      tabVideoRegistry[tabId].push(video);
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
      existingVideo = tabVideoRegistry[tabId].find(v => {
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
      
      existingVideo = tabVideoRegistry[tabId].find(v => {
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
            const beforeCount = tabVideoRegistry[tabId].length;
            tabVideoRegistry[tabId] = tabVideoRegistry[tabId].filter((v) => {
              return v.type !== "hls" || (v.qualities && v.qualities.length > 0);
            });
            if (tabVideoRegistry[tabId].length !== beforeCount) {
              console.log("[Detector] Replaced video-only HLS media playlists with master HLS playlist.");
            }
          } else {
            const hasMasterHls = tabVideoRegistry[tabId].some((v) => {
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
        tabVideoRegistry[tabId].push(video);
        console.log(`[Detector] Video registered for Tab ${tabId}: ${video.url}`);
        
        updateBadgeCount(tabId);
        persistDebounced();
      } else if (existingVideo) {
        let enriched = false;
        
        // For Instagram quality selection: only overwrite if new video has a larger size (higher quality)
        const isInstagramMatch = video.url && video.url.includes("cdninstagram.com") && 
                                 existingVideo.url && existingVideo.url.includes("cdninstagram.com");
        
        if (isInstagramMatch) {
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

  // If it's a DOM-detected direct video, check its size via HEAD request first
  if (video.quality === "DOM" && !isYoutube && !isManifest && video.url) {
    fetch(video.url, { method: "HEAD" })
      .then((res) => {
        const len = res.headers.get("content-length");
        if (len) {
          const size = parseInt(len);
          const isInstagram = video.url && video.url.includes("cdninstagram.com");
          if (!isInstagram && !isNaN(size) && size < MIN_DIRECT_MEDIA_SIZE) {
            console.log(`[Detector] Skipping small DOM media (${size} bytes): ${video.url}`);
            return;
          }
          if (!isNaN(size)) {
            video.sizeBytes = size;
          }
        }
        doRegister();
      })
      .catch((err) => {
        // Fallback: register anyway if the HEAD request fails
        doRegister();
      });
  } else {
    doRegister();
  }
}

// Recalculates total downloading options available and updates badge text
function updateBadgeCount(tabId) {
  const registry = (tabVideoRegistry[tabId] || []).filter(isPlayableDetectedVideo);
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

  if (message.action === "background_proxy_fetch") {
    const options = {};
    if (typeof message.frameId === "number") {
      options.frameId = message.frameId;
    }
    chrome.tabs.sendMessage(message.tabId, {
      action: "proxy_fetch",
      url: message.url,
      options: message.options,
      responseType: message.responseType
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
      tabVideoRegistry[tabId] = [];
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
      const beforeCount = tabVideoRegistry[tabId].length;
      const cleanUrl = message.url.split('?')[0].split('#')[0].toLowerCase();
      tabVideoRegistry[tabId] = tabVideoRegistry[tabId].filter(v => {
        const vCleanUrl = v.url.split('?')[0].split('#')[0].toLowerCase();
        return vCleanUrl !== cleanUrl;
      });
      if (tabVideoRegistry[tabId].length !== beforeCount) {
        console.log(`[Detector] Unregistered video due to DOM removal: ${message.url}`);
        updateBadgeCount(tabId);
        persistDebounced();
        chrome.runtime.sendMessage({ action: "video_registry_updated", tabId: tabId }).catch(() => {});
      }
    }
    sendResponse({ success: true });
  } else if (message.action === "get_detected_videos") {
    // Popup requesting detected list
    const targetTabId = message.tabId || (sender.tab ? sender.tab.id : null);
    if (targetTabId) {
      chrome.tabs.get(targetTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          const videos = (tabVideoRegistry[targetTabId] || []).filter(isPlayableDetectedVideo);
          sendResponse({ videos });
          return;
        }

        const url = tab.url || "";
        const isYoutubeWatchPage = url.includes("youtube.com/watch") || url.includes("youtu.be/");
        
        if (isYoutubeWatchPage) {
          if (!tabVideoRegistry[targetTabId]) {
            tabVideoRegistry[targetTabId] = [];
          }
          const registry = tabVideoRegistry[targetTabId];
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

        const videos = (tabVideoRegistry[targetTabId] || []).filter(isPlayableDetectedVideo);
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
  delete tabVideoRegistry[tabId];
  delete tabYoutubeMediaState[tabId];
  delete tabRecentAudios[tabId];
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
    // If navigating within youtube.com, let the player response sniffer handle the video transition/registry reset
    try {
      const oldUrl = tab.url;
      const newUrl = changeInfo.url;
      if (oldUrl && newUrl) {
        const oldHost = new URL(oldUrl).hostname;
        const newHost = new URL(newUrl).hostname;
        if (oldHost.includes("youtube.com") && newHost.includes("youtube.com")) {
          console.log(`[Detector] Tab ${tabId} navigated within YouTube. Bypassing registry wipe.`);
          return;
        }
      }
    } catch (e) {}

    console.log(`[Detector] Tab ${tabId} navigated to ${changeInfo.url}. Clearing registry.`);
    tabVideoRegistry[tabId] = [];
    delete tabYoutubeMediaState[tabId];
    delete tabRecentAudios[tabId];
    unregisterDnrRulesForDownload(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
    persistDebounced();
    chrome.runtime.sendMessage({ action: "video_registry_cleared", tabId: tabId }).catch(() => {});
  }
});

// Sets up and creates the offscreen document if it doesn't already exist
async function setupOffscreenDocument(path) {
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

// Closes the offscreen document if there are no active downloads
async function closeOffscreenDocument() {
  if (Object.keys(activeDownloads).length === 0) {
    try {
      await chrome.offscreen.closeDocument();
      console.log("[Detector] Closed offscreen document.");
    } catch (e) {
      // Ignore if already closed
    }
  }
}

// Delegates sequential segment fetching to the offscreen DOM context
function getFrameUrlForVideo(tabId, url) {
  const registry = tabVideoRegistry[tabId] || [];
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
      await registerDnrRulesForDownload(tabId, frameUrl);
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
      await registerDnrRulesForDownload(tabId, frameUrl);
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
      await registerDnrRulesForDownload(tabId, frameUrl);
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
