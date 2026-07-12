// offscreen.js
import { parseM3U8 } from './hls-parser.js';
import { HlsDownloader, DirectMediaMerger, DirectMediaDownloader, YoutubeDownloader } from './downloader.js';

const activeDownloads = {};

console.log("[Offscreen] Offscreen script initialized.");

async function validateDownload(blob, expectedSize) {
  if (blob.size < 1024) {
    throw new Error(`Downloaded file suspiciously small (${blob.size} bytes) — likely an error page, not media.`);
  }
  if (expectedSize && Math.abs(blob.size - expectedSize) > expectedSize * 0.05) {
    console.warn(`[Downloader] Size mismatch: expected ~${expectedSize} bytes, got ${blob.size}. Proceeding anyway.`);
  }
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const isMp4 = String.fromCharCode(...head.slice(4, 8)) === "ftyp";
    const isWebm = head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3;
    const isTs = head[0] === 0x47;
    if (!isMp4 && !isWebm && !isTs) {
      console.warn("[Downloader] Blob doesn't look like a valid media container — may be an error response.");
    }
  } catch (e) {
    console.warn("[Downloader] Failed to sniff first bytes of blob:", e);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "start_offscreen_hls_download") {
    handleHlsDownload(message.tabId, message.url, message.qualityTitle, message.pageTitle, message.frameId);
    sendResponse({ success: true });
  } else if (message.action === "start_combined_media_download") {
    handleCombinedMediaDownload(message.tabId, message.videoUrl, message.audioUrl, message.pageTitle, message.frameId);
    sendResponse({ success: true });
  } else if (message.action === "start_offscreen_direct_download") {
    handleDirectDownload(message.tabId, message.url, message.pageTitle, message.expectedSize, message.frameId);
    sendResponse({ success: true });
  } else if (message.action === "start_offscreen_youtube_download") {
    handleYoutubeDownload(message.tabId, message.videoUrl, message.audioUrl, message.pageTitle, message.resolution, message.frameId, message.youtubeUrl);
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

async function handleCombinedMediaDownload(tabId, videoUrl, audioUrl, pageTitle, frameId) {
  console.log(`[Offscreen] Initiating combined media download for tab ${tabId}`);
  try {
    const merger = new DirectMediaMerger(videoUrl, audioUrl, (progress) => {
      chrome.runtime.sendMessage({
        action: "download_progress_update",
        tabId: tabId,
        progress: progress
      }).catch(() => {});
    }, tabId, frameId);
    activeDownloads[tabId] = merger;
    const result = await merger.start();
    const blob = result.blob || result;
    const extension = result.extension || "mp4";

    await validateDownload(blob);

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

async function handleHlsDownload(tabId, m3u8Url, qualityTitle, pageTitle, frameId) {
  console.log(`[Offscreen] Initiating download for tab ${tabId}: ${m3u8Url}`);
  try {
    // 1. Fetch and parse manifest
    const qualities = await parseM3U8(m3u8Url, tabId, frameId);
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
    }, audioUrl, tabId, frameId);

    activeDownloads[tabId] = downloader;
    const result = await downloader.start();
    const blob = result.blob || result;
    const extension = result.extension || "mp4";
    
    await validateDownload(blob);

    // 3. Create Object URL (Supported here!)
    const objectUrl = URL.createObjectURL(blob);
    
    const qualitySuffix = (qualityTitle && qualityTitle !== "Auto") ? `_${qualityTitle}` : "";
    const safeTitle = sanitizeFilename(`${pageTitle}${qualitySuffix}`, "hls_video");

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

async function handleDirectDownload(tabId, url, pageTitle, expectedSize, frameId) {
  console.log(`[Offscreen] Initiating direct download for tab ${tabId}: ${url}, expectedSize: ${expectedSize}`);
  try {
    const downloader = new DirectMediaDownloader(url, (progress) => {
      chrome.runtime.sendMessage({
        action: "download_progress_update",
        tabId: tabId,
        progress: progress
      }).catch(() => {});
    }, tabId, frameId, expectedSize);

    activeDownloads[tabId] = downloader;
    const result = await downloader.start();
    const blob = result.blob;
    const extension = result.extension;

    await validateDownload(blob, expectedSize);

    const objectUrl = URL.createObjectURL(blob);
    const safeTitle = sanitizeFilename(pageTitle, "video");

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

async function handleYoutubeDownload(tabId, videoUrl, audioUrl, pageTitle, resolution, frameId, youtubeUrl) {
  console.log(`[Offscreen] Initiating YouTube download for tab ${tabId}. Video: ${videoUrl}, Audio: ${audioUrl}, YoutubeUrl: ${youtubeUrl}`);
  try {
    const downloader = new YoutubeDownloader(videoUrl, audioUrl, (progress) => {
      chrome.runtime.sendMessage({
        action: "download_progress_update",
        tabId: tabId,
        progress: progress
      }).catch(() => {});
    }, tabId, frameId, youtubeUrl, resolution);

    activeDownloads[tabId] = downloader;
    const result = await downloader.start();
    const blob = result.blob;
    const extension = result.extension;

    await validateDownload(blob);

    const objectUrl = URL.createObjectURL(blob);
    const safeTitle = sanitizeFilename(pageTitle, "youtube_video");

    console.log(`[Offscreen] YouTube download and mux complete. Triggering download for: ${safeTitle}.${extension}`);
    
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeTitle}_${resolution || "1080p"}.${extension}`;
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
    console.error(`[Offscreen] YouTube download failed:`, error);
    chrome.runtime.sendMessage({
      action: "download_error",
      tabId: tabId,
      error: error.message
    }).catch(() => {});
    delete activeDownloads[tabId];
  }
}

function sanitizeFilename(title, defaultName) {
  if (!title) return defaultName;
  let safe = title.replace(/[\\/*?:"<>|]/g, "").trim();
  if (safe.length > 96) {
    safe = safe.substring(0, 96).trim();
  }
  return safe || defaultName;
}
