import { parseM3U8 } from './hls-parser.js';

const YOUTUBE_ITAGS = {
  18: { resolution: "360p (MP4)", type: "mp4", title: "YouTube Video (with Audio)" },
  22: { resolution: "720p (MP4)", type: "mp4", title: "YouTube Video (with Audio)" },
  37: { resolution: "1080p (MP4)", type: "mp4", title: "YouTube Video (with Audio)" },
  38: { resolution: "3072p (MP4)", type: "mp4", title: "YouTube Video (with Audio)" },
  
  // Video only (MP4 / AVC)
  137: { resolution: "1080p (MP4)", type: "mp4", title: "YouTube Video (Video Only)" },
  136: { resolution: "720p (MP4)", type: "mp4", title: "YouTube Video (Video Only)" },
  135: { resolution: "480p (MP4)", type: "mp4", title: "YouTube Video (Video Only)" },
  134: { resolution: "360p (MP4)", type: "mp4", title: "YouTube Video (Video Only)" },
  133: { resolution: "240p (MP4)", type: "mp4", title: "YouTube Video (Video Only)" },
  160: { resolution: "144p (MP4)", type: "mp4", title: "YouTube Video (Video Only)" },
  
  // Video only (WebM / VP9)
  248: { resolution: "1080p (WebM)", type: "webm", title: "YouTube Video (Video Only)" },
  247: { resolution: "720p (WebM)", type: "webm", title: "YouTube Video (Video Only)" },
  244: { resolution: "480p (WebM)", type: "webm", title: "YouTube Video (Video Only)" },
  243: { resolution: "360p (WebM)", type: "webm", title: "YouTube Video (Video Only)" },
  271: { resolution: "1440p (WebM)", type: "webm", title: "YouTube Video (Video Only)" },
  313: { resolution: "2160p (4K, WebM)", type: "webm", title: "YouTube Video (Video Only)" },
  
  // Video only (AV1)
  399: { resolution: "1080p (AV1)", type: "mp4", title: "YouTube Video (Video Only)" },
  398: { resolution: "720p (AV1)", type: "mp4", title: "YouTube Video (Video Only)" },
  397: { resolution: "480p (AV1)", type: "mp4", title: "YouTube Video (Video Only)" },
  396: { resolution: "360p (AV1)", type: "mp4", title: "YouTube Video (Video Only)" },
  
  // Audio only
  140: { resolution: "128kbps (M4A)", type: "m4a", title: "YouTube Audio" },
  251: { resolution: "160kbps (WebM)", type: "webm", title: "YouTube Audio" },
  139: { resolution: "48kbps (M4A)", type: "m4a", title: "YouTube Audio" },
  171: { resolution: "128kbps (WebM)", type: "webm", title: "YouTube Audio" },
  249: { resolution: "50kbps (WebM)", type: "webm", title: "YouTube Audio" },
  250: { resolution: "70kbps (WebM)", type: "webm", title: "YouTube Audio" }
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

// 1. Network Interception via webRequest API (equivalent to shouldInterceptRequest in Android)
// Inspects response headers to confirm content types while ignoring HTML pages and HLS .ts segments
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, type, responseHeaders } = details;
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
            registerVideo(tabId, {
              url: url,
              type: "youtube_stream",
              quality: "YouTube",
              resolution: itagInfo.resolution,
              title: itagInfo.title,
              itag: itag
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

      // Check Content-Length size constraint (must be at least 500 KB for direct media)
      const contentLengthHeader = responseHeaders.find(
        (h) => h.name.toLowerCase() === "content-length"
      );
      if (contentLengthHeader && !isManifest) {
        const size = parseInt(contentLengthHeader.value);
        if (!isNaN(size) && size < 512000) {
          console.log(`[Detector] Skipping small network media (${size} bytes): ${url}`);
          return;
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
        registerVideo(tabId, {
          url,
          type: mediaType,
          quality: "Network",
          resolution: mediaType === "hls" || mediaType === "dash" ? "Auto" : "Direct",
          title: mediaTitle
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

// Registers the detected video, ensuring uniqueness and computing exact options count
function registerVideo(tabId, video) {
  if (!tabVideoRegistry[tabId]) {
    tabVideoRegistry[tabId] = [];
  }

  // 1. Prioritize HLS streams: if HLS is already registered, skip direct links (prevents background preview/ad clutter)
  const hasHls = tabVideoRegistry[tabId].some(v => v.type === "hls");
  if (hasHls && video.type !== "hls") {
    console.log(`[Detector] HLS stream already sniffed. Ignoring direct link: ${video.url}`);
    return;
  }

  // 2. If the new stream is HLS, clear out any direct video files (previews/ads) previously registered
  if (video.type === "hls" && !hasHls) {
    console.log(`[Detector] Sniffed HLS stream. Purging direct video files to keep list clean.`);
    tabVideoRegistry[tabId] = tabVideoRegistry[tabId].filter(v => v.type === "hls");
  }

  const isYoutube = (video.url && (video.url.includes("googlevideo.com/videoplayback") || video.url.includes("youtube.com/videoplayback"))) || video.type === "youtube_stream" || video.itag;
  const isManifest = video.type === "hls" || video.type === "dash" || (video.url && (video.url.includes(".m3u8") || video.url.includes(".mpd")));

  const doRegister = () => {
    let exists = false;
    if (isYoutube) {
      const itag = video.itag || (video.url ? new URL(video.url).searchParams.get("itag") : null);
      exists = tabVideoRegistry[tabId].some(v => {
        const vIsYoutube = (v.url && (v.url.includes("googlevideo.com/videoplayback") || v.url.includes("youtube.com/videoplayback"))) || v.type === "youtube_stream" || v.itag;
        if (vIsYoutube) {
          const vItag = v.itag || (v.url ? new URL(v.url).searchParams.get("itag") : null);
          return String(vItag) === String(itag);
        }
        return false;
      });
    } else {
      const getCleanUrl = (url) => url.split('?')[0].split('#')[0];
      const videoCleanUrl = getCleanUrl(video.url);
      exists = tabVideoRegistry[tabId].some(v => getCleanUrl(v.url) === videoCleanUrl);
    }

    if (!exists) {
      chrome.tabs.get(tabId, async (tab) => {
        if (chrome.runtime.lastError) return;
        
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
          } catch (e) {
            console.warn("[Detector] Failed HLS quality check in background:", e);
            video.qualities = [];
          }
        }

        tabVideoRegistry[tabId].push(video);
        console.log(`[Detector] Video registered for Tab ${tabId}: ${video.url}`);
        
        updateBadgeCount(tabId);
      });
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
  const registry = tabVideoRegistry[tabId] || [];
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
  const tabId = sender.tab ? sender.tab.id : null;

  if (message.action === "register_detected_video") {
    // Media URL detected via DOM/MutationObserver or API hook
    if (tabId) {
      registerVideo(tabId, message.video);
    }
  } else if (message.action === "get_detected_videos") {
    // Popup requesting detected list
    const videos = tabVideoRegistry[message.tabId] || [];
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
    chrome.action.setBadgeText({ tabId, text: "" });
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
    chrome.tabs.get(tabId, (tab) => {
      const pageTitle = (tab && tab.title) ? tab.title : "hls_video";
      
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
