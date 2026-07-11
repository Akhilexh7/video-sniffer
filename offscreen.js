// offscreen.js
import { parseM3U8 } from './hls-parser.js';
import { HlsDownloader, DirectMediaMerger, DirectMediaDownloader } from './downloader.js';

const activeDownloads = {};

console.log("[Offscreen] Offscreen script initialized.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "start_offscreen_hls_download") {
    handleHlsDownload(message.tabId, message.url, message.qualityTitle, message.pageTitle);
    sendResponse({ success: true });
  } else if (message.action === "start_combined_media_download") {
    handleCombinedMediaDownload(message.tabId, message.videoUrl, message.audioUrl, message.pageTitle);
    sendResponse({ success: true });
  } else if (message.action === "start_offscreen_direct_download") {
    handleDirectDownload(message.tabId, message.url, message.pageTitle);
    sendResponse({ success: true });
  } else if (message.action === "cancel_offscreen_hls_download") {
    const downloader = activeDownloads[message.tabId];
    if (downloader) {
      downloader.cancel();
      delete activeDownloads[message.tabId];
    }
    sendResponse({ success: true });
  }
  return true;
});

async function handleCombinedMediaDownload(tabId, videoUrl, audioUrl, pageTitle) {
  console.log(`[Offscreen] Initiating combined media download for tab ${tabId}`);
  try {
    const merger = new DirectMediaMerger(videoUrl, audioUrl);
    activeDownloads[tabId] = merger;
    const result = await merger.start();
    const blob = result.blob || result;
    const extension = result.extension || "webm";

    const objectUrl = URL.createObjectURL(blob);
    const safeTitle = (pageTitle || "instagram_video")
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .substring(0, 30);

    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeTitle}.${extension}`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      delete activeDownloads[tabId];
      chrome.runtime.sendMessage({ action: "offscreen_download_complete", tabId }).catch(() => {});
    }, 1000);
  } catch (error) {
    console.error(`[Offscreen] Combined media download failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
  }
}

async function handleHlsDownload(tabId, m3u8Url, qualityTitle, pageTitle) {
  console.log(`[Offscreen] Initiating download for tab ${tabId}: ${m3u8Url}`);
  try {
    // 1. Fetch and parse manifest
    const qualities = await parseM3U8(m3u8Url);
    let downloadUrl = m3u8Url;
    let audioUrl = null;
    
    if (qualities.length > 0) {
      const selected = qualities.find(q => q.quality === qualityTitle) || qualities[0];
      downloadUrl = selected.url;
      audioUrl = selected.audioUrl || null;
      console.log(audioUrl
        ? `[Offscreen] Selected HLS quality includes separate audio playlist: ${audioUrl}`
        : "[Offscreen] Selected HLS quality has no separate audio playlist; assuming audio is muxed in the video playlist.");
    }

    // 2. Start segment downloader
    const downloader = new HlsDownloader(downloadUrl, (progress) => {
      // Forward progress directly to popup/background
      chrome.runtime.sendMessage({
        action: "download_progress_update",
        tabId: tabId,
        progress: progress
      }).catch(() => {
        // Suppress errors when popup is closed
      });
    }, audioUrl);

    activeDownloads[tabId] = downloader;
    const result = await downloader.start();
    const blob = result.blob || result;
    const extension = result.extension || "mp4";
    
    // 3. Create Object URL (Supported here!)
    const objectUrl = URL.createObjectURL(blob);
    
    const safeTitle = (pageTitle || "hls_video")
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .substring(0, 30);

    console.log(`[Offscreen] Merging complete. Triggering native anchor download for: ${safeTitle}.${extension}`);
    
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeTitle}.${extension}`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      
      delete activeDownloads[tabId];
      chrome.runtime.sendMessage({
        action: "offscreen_download_complete",
        tabId: tabId
      }).catch(() => {});
    }, 1000);

  } catch (error) {
    console.error(`[Offscreen] Download failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
  }
}

async function handleDirectDownload(tabId, url, pageTitle) {
  console.log(`[Offscreen] Initiating direct download for tab ${tabId}: ${url}`);
  try {
    const downloader = new DirectMediaDownloader(url, (progress) => {
      chrome.runtime.sendMessage({
        action: "download_progress_update",
        tabId: tabId,
        progress: progress
      }).catch(() => {});
    }, tabId);

    activeDownloads[tabId] = downloader;
    const result = await downloader.start();
    const blob = result.blob;
    const extension = result.extension;

    const objectUrl = URL.createObjectURL(blob);
    const safeTitle = (pageTitle || "video")
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .substring(0, 30);

    console.log(`[Offscreen] Download complete. Triggering native anchor download for: ${safeTitle}.${extension}`);
    
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeTitle}.${extension}`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
      
      delete activeDownloads[tabId];
      chrome.runtime.sendMessage({
        action: "offscreen_download_complete",
        tabId: tabId
      }).catch(() => {});
    }, 1000);

  } catch (error) {
    console.error(`[Offscreen] Direct media download failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
  }
}
