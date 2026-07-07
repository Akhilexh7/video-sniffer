// offscreen.js
import { parseM3U8 } from './hls-parser.js';
import { HlsDownloader } from './downloader.js';

const activeDownloads = {};

console.log("[Offscreen] Offscreen script initialized.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "start_offscreen_hls_download") {
    handleHlsDownload(message.tabId, message.url, message.qualityTitle, message.pageTitle);
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

async function handleHlsDownload(tabId, m3u8Url, qualityTitle, pageTitle) {
  console.log(`[Offscreen] Initiating download for tab ${tabId}: ${m3u8Url}`);
  try {
    // 1. Fetch and parse manifest
    const qualities = await parseM3U8(m3u8Url);
    let downloadUrl = m3u8Url;
    
    if (qualities.length > 0) {
      const selected = qualities.find(q => q.quality === qualityTitle) || qualities[0];
      downloadUrl = selected.url;
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
    });

    activeDownloads[tabId] = downloader;
    const blob = await downloader.start();
    
    // 3. Create Object URL (Supported here!)
    const objectUrl = URL.createObjectURL(blob);
    
    const safeTitle = (pageTitle || "hls_video")
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase()
      .substring(0, 30);

    console.log(`[Offscreen] Merging complete. Triggering native anchor download for: ${safeTitle}.mp4`);
    
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeTitle}.mp4`;
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
