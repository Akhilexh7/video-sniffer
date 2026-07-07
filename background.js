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

      let mediaType = null;
      let mediaTitle = "";
      const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();

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

// Registers the detected video, ensuring uniqueness
function registerVideo(tabId, video) {
  if (!tabVideoRegistry[tabId]) {
    tabVideoRegistry[tabId] = [];
  }

  const getCleanUrl = (url) => url.split('?')[0].split('#')[0];
  const videoCleanUrl = getCleanUrl(video.url);

  // Check if a video with the same clean URL already exists
  const exists = tabVideoRegistry[tabId].some(v => getCleanUrl(v.url) === videoCleanUrl);
  if (!exists) {
    // Add page title placeholder, content script will update it if possible
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      video.pageTitle = tab.title || "Video Stream";
      tabVideoRegistry[tabId].push(video);
      console.log(`[Detector] Video URL registered in Tab ${tabId}: ${video.url}`);
      
      // Update badge count
      chrome.action.setBadgeText({ tabId, text: String(tabVideoRegistry[tabId].length) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#4f46e5" });
    });
  }
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
