import { parseM3U8 } from './hls-parser.js';

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

// Tab-based video database
// tabId -> Array of detected video objects
const tabVideoRegistry = {};

// Active HLS downloads: tabId -> { url, qualityTitle, progress }
const activeDownloads = {};

let creatingOffscreen; // Global promise for offscreen lifecycle

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
    console.log(`[DNR] Registered headers rules for Tab ${tabId}. Referer: ${pageUrl}, Origin: ${origin}`);
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

// 1. Network Interception via webRequest API (equivalent to shouldInterceptRequest in Android)
// Inspects response headers to confirm content types while ignoring HTML pages and HLS .ts segments
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, type, responseHeaders, statusCode } = details;
    if (tabId < 0) return;

    // Intercept YouTube streams before other content type checks
    if (url.includes("googlevideo.com/videoplayback") || url.includes("youtube.com/videoplayback")) {
      try {
        const urlObj = new URL(url);
        const itagStr = urlObj.searchParams.get("itag");
        if (itagStr) {
          const itag = parseInt(itagStr);
          const itagInfo = YOUTUBE_ITAGS[itag];
          if (itagInfo) {
            if (!itagInfo.hasAudio || !itagInfo.hasVideo) {
              console.log(`[Detector] Ignoring YouTube adaptive stream without both audio and video. itag=${itag}`);
              return;
            }
            registerVideo(tabId, {
              url: url,
              type: "youtube_stream",
              quality: "YouTube",
              resolution: itagInfo.resolution,
              title: itagInfo.title,
              itag: itag,
              hasAudio: itagInfo.hasAudio,
              hasVideo: itagInfo.hasVideo
            });
            return;
          }
        }
      } catch (e) {
        console.error("[Detector] Error intercepting YouTube stream:", e);
      }
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

      // EXPLICITLY IGNORE HLS segment stream chunks (video/mp2t) to prevent flooding the list
      if (contentType.includes("video/mp2t") || cleanUrlEndsWith(url, ".ts")) {
        return;
      }

      const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
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
        if (!isNaN(comparableSize) && comparableSize < 512000) {
          console.log(`[Detector] Skipping small network media (${size} bytes): ${url}`);
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

        registerVideo(tabId, {
          url: normalizedMediaUrl,
          type: mediaType,
          quality: "Network",
          resolution: mediaType === "hls" || mediaType === "dash" ? "Auto" : "Direct",
          title: mediaTitle,
          sizeBytes
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
    if (url.hostname.includes("cdninstagram.com")) {
      return url.href;
    }
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
  if (video.type === "hls") return true;
  if (video.hasVideo === false) return false;
  if (video.hasAudio === false && !video.audioUrl) return false;
  const title = String(video.title || "").toLowerCase();
  return !title.includes("video only");
}

// Registers the detected video, ensuring uniqueness and computing exact options count
function registerVideo(tabId, video) {
  if (!tabVideoRegistry[tabId]) {
    tabVideoRegistry[tabId] = [];
  }

  if (video.url && video.type !== "hls" && video.type !== "dash" && !video.url.includes("cdninstagram.com")) {
    video.url = normalizeRangedMediaUrl(video.url);
  }



  const isYoutube = (video.url && (video.url.includes("googlevideo.com/videoplayback") || video.url.includes("youtube.com/videoplayback"))) || video.type === "youtube_stream" || video.itag;
  const isManifest = video.type === "hls" || video.type === "dash" || (video.url && (video.url.includes(".m3u8") || video.url.includes(".mpd")));

  const doRegister = () => {
    if (video.type !== "hls" && video.hasVideo === false) {
      console.log(`[Detector] Ignoring incomplete media entry: ${video.url}`);
      return;
    }

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
      existingVideo = tabVideoRegistry[tabId].find(v => getCleanUrl(v.url) === videoCleanUrl);
      exists = !!existingVideo;
    }

    if (!exists) {
      chrome.tabs.get(tabId, async (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        
        if (tab.url) {
          await registerDnrRulesForDownload(tabId, tab.url);
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

        video.pageTitle = tab.title || "Video Stream";
        
        // Fetch HLS qualities in background immediately to calculate options count
        if (video.type === "hls") {
          try {
            console.log("[Detector] Parsing HLS qualities in background...");
            const qualities = await parseM3U8(video.url);
            video.qualities = qualities || [];
            video.isHlsMaster = video.qualities.length > 0;
            video.hasSeparateAudio = video.qualities.some((quality) => !!quality.audioUrl);
          } catch (e) {
            console.warn("[Detector] Failed HLS quality check in background:", e);
            video.qualities = [];
            video.isHlsMaster = false;
            video.hasSeparateAudio = false;
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

        tabVideoRegistry[tabId].push(video);
        console.log(`[Detector] Video registered for Tab ${tabId}: ${video.url}`);
        
        updateBadgeCount(tabId);
      });
    } else if (existingVideo) {
      let enriched = false;
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
      if (enriched) {
        console.log(`[Detector] Enriched existing video metadata: ${video.url}`);
      }
    }
  };

  // If it's a DOM-detected direct video, check its size via HEAD request first
  if (video.quality === "DOM" && !isYoutube && !isManifest && video.url) {
    fetch(video.url, { method: "HEAD" })
      .then((res) => {
        const len = res.headers.get("content-length");
        if (len) {
          const size = parseInt(len);
          if (!isNaN(size) && size < 512000) {
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

// 3. Handle messages from Content Script and Popup UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "background_proxy_fetch") {
    chrome.tabs.sendMessage(message.tabId, {
      action: "proxy_fetch",
      url: message.url,
      options: message.options,
      responseType: message.responseType
    }, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response);
      }
    });
    return true; // Keep message channel open
  }

  const tabId = sender.tab ? sender.tab.id : null;

  if (message.action === "clear_video_registry") {
    if (tabId) {
      console.log(`[Detector] Tab ${tabId} requested registry clear (reload).`);
      tabVideoRegistry[tabId] = [];
      unregisterDnrRulesForDownload(tabId);
      chrome.action.setBadgeText({ tabId, text: "" });
      chrome.runtime.sendMessage({ action: "video_registry_cleared", tabId: tabId }).catch(() => {});
    }
    sendResponse({ success: true });
  } else if (message.action === "register_detected_video") {
    // Media URL detected via DOM/MutationObserver or API hook
    if (tabId) {
      registerVideo(tabId, message.video);
    }
  } else if (message.action === "get_detected_videos") {
    // Popup requesting detected list
    const videos = (tabVideoRegistry[message.tabId] || []).filter(isPlayableDetectedVideo);
    sendResponse({ videos });
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
    handleHlsDownload(message.tabId, message.url, message.qualityTitle);
    sendResponse({ success: true });
  } else if (message.action === "start_combined_media_download") {
    // Delegate combined media download to offscreen document
    handleCombinedMediaDownload(message.tabId, message.videoUrl, message.audioUrl, message.pageTitle);
    sendResponse({ success: true });
  } else if (message.action === "start_direct_download") {
    // Delegate direct media download to offscreen document
    handleDirectDownload(message.tabId, message.url, message.pageTitle);
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
  }
  return true;
});

// Cleans up memory when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideoRegistry[tabId];
  unregisterDnrRulesForDownload(tabId);
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
    console.log(`[Detector] Tab ${tabId} navigated to ${changeInfo.url}. Clearing registry.`);
    tabVideoRegistry[tabId] = [];
    unregisterDnrRulesForDownload(tabId);
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.runtime.sendMessage({ action: "video_registry_cleared", tabId: tabId }).catch(() => {});
  }
});

// Sets up and creates the offscreen document if it doesn't already exist
async function setupOffscreenDocument(path) {
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
async function handleHlsDownload(tabId, m3u8Url, qualityTitle) {
  console.log(`[Downloader] Delegating HLS Download for tab ${tabId} to Offscreen Document.`);
  
  // Store initial download state
  activeDownloads[tabId] = { url: m3u8Url, qualityTitle, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    // Retrieve page title in background (which has chrome.tabs access) and forward it to offscreen script
    chrome.tabs.get(tabId, async (tab) => {
      const pageTitle = (tab && tab.title) ? tab.title : "hls_video";
      if (tab && tab.url) {
        await registerDnrRulesForDownload(tabId, tab.url);
      }
      
      // Adding a minor timeout ensures that the DOM scripts in the offscreen page are mounted
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: "start_offscreen_hls_download",
          tabId: tabId,
          url: m3u8Url,
          qualityTitle: qualityTitle,
          pageTitle: pageTitle
        }).catch((e) => {
          console.error("[Downloader] Failed to communicate with offscreen document:", e);
        });
      }, 500);
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

async function handleCombinedMediaDownload(tabId, videoUrl, audioUrl, pageTitle) {
  console.log(`[Downloader] Delegating Combined Download for tab ${tabId} to Offscreen Document.`);
  
  activeDownloads[tabId] = { url: videoUrl, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    chrome.tabs.get(tabId, async (tab) => {
      const title = pageTitle || ((tab && tab.title) ? tab.title : "combined_video");
      if (tab && tab.url) {
        await registerDnrRulesForDownload(tabId, tab.url);
      }
      
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: "start_combined_media_download",
          tabId: tabId,
          videoUrl: videoUrl,
          audioUrl: audioUrl,
          pageTitle: title
        }).catch((e) => {
          console.error("[Downloader] Failed to communicate with offscreen document for combined download:", e);
        });
      }, 500);
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

async function handleDirectDownload(tabId, url, pageTitle) {
  console.log(`[Downloader] Delegating Direct Download for tab ${tabId} to Offscreen Document.`);
  
  activeDownloads[tabId] = { url: url, progress: 0 };
  
  try {
    await setupOffscreenDocument('offscreen.html');
    
    chrome.tabs.get(tabId, async (tab) => {
      const title = pageTitle || ((tab && tab.title) ? tab.title : "video");
      if (tab && tab.url) {
        await registerDnrRulesForDownload(tabId, tab.url);
      }
      
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: "start_offscreen_direct_download",
          tabId: tabId,
          url: url,
          pageTitle: title
        }).catch((e) => {
          console.error("[Downloader] Failed to communicate with offscreen document for direct download:", e);
        });
      }, 500);
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
