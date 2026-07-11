// popup.js
import { parseM3U8 } from './hls-parser.js';

let activeTabId = null;
let currentVideos = [];

// DOM Elements
const stateWaiting = document.getElementById("state-waiting");
const stateDetected = document.getElementById("state-detected");

const videoList = document.getElementById("video-list");

// Inline Download Banner Elements
const downloadProgressBanner = document.getElementById("download-progress-banner");
const bannerPercentage = document.getElementById("banner-percentage");
const bannerBarFill = document.getElementById("banner-bar-fill");
const bannerDetail = document.getElementById("banner-detail");
const bannerCancelBtn = document.getElementById("banner-cancel-btn");

const qualityDialog = document.getElementById("quality-dialog");
const qualityOptions = document.getElementById("quality-options");
const closeDialogBtn = document.getElementById("close-dialog-btn");

// Initialize popup
async function init() {
  console.log("[Detector] Popup opened.");
  
  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;

  // 1. Fetch detected videos for the active tab (unconditional, so they stay visible)
  refreshVideoList();

  // 2. Check if there's an active download running for this tab to show inline progress
  chrome.runtime.sendMessage({ action: "get_download_progress", tabId: activeTabId }, (response) => {
    if (response && response.downloading) {
      showDownloadProgress(response.progress);
    } else {
      hideDownloadProgress();
    }
  });

  // Setup static event listeners
  bannerCancelBtn.addEventListener("click", cancelDownload);
  closeDialogBtn.addEventListener("click", () => qualityDialog.classList.add("hidden"));
}

function refreshVideoList() {
  chrome.runtime.sendMessage({ action: "get_detected_videos", tabId: activeTabId }, async (response) => {
    if (response && response.videos && response.videos.length > 0) {
      const sortedVideos = sortVideosBySize(response.videos);
      currentVideos = sortedVideos;
      renderVideoCards(sortedVideos);
    } else {
      showState("waiting");
    }
  });
}

function showState(state) {
  stateWaiting.classList.add("hidden");
  stateDetected.classList.add("hidden");

  if (state === "waiting") {
    stateWaiting.classList.remove("hidden");
  } else if (state === "detected") {
    stateDetected.classList.remove("hidden");
  }
}

function sortVideosBySize(videos) {
  return [...videos].sort((a, b) => {
    const sizeA = getSortableSizeBytes(a);
    const sizeB = getSortableSizeBytes(b);

    if (sizeA !== sizeB) return sizeB - sizeA;
    if (a.type === "hls" && b.type !== "hls") return -1;
    if (a.type !== "hls" && b.type === "hls") return 1;
    return 0;
  });
}

function getSortableSizeBytes(video) {
  if (video.sizeBytes) return Number(video.sizeBytes) || 0;

  if (video.type === "hls") {
    const bandwidth = getBestHlsBandwidth(video);
    if (bandwidth) {
      return (bandwidth / 8) * 3600;
    }
  }

  return 0;
}

// Renders HLS streams at the top and direct media links below
function renderVideoCards(videos) {
  videoList.innerHTML = "";
  showState("detected");

  videos.forEach((video) => {
    const card = document.createElement("div");
    card.className = "video-card";
    const previewMarkup = createPreviewMarkup(video);
    
    if (video.type === "hls") {
      card.innerHTML = `
        <div class="video-info">
          ${previewMarkup}
          <div class="video-meta">
            <div class="video-title" style="font-size: 14px; font-weight: 600; color: var(--accent-primary);">${video.pageTitle || "HLS Video Stream"}</div>
          </div>
        </div>
        <button class="btn btn-primary download-action-btn">
          Select Quality
        </button>
      `;

      card.querySelector(".download-action-btn").addEventListener("click", () => {
        handleHlsCardClick(video);
      });
      card.addEventListener("click", (e) => {
        if (!e.target.classList.contains("download-action-btn")) {
          handleHlsCardClick(video);
        }
      });
    } else {
      const sizeText = getCardSizeText(video);
      const ext = video.type.toUpperCase();
      const res = video.resolution !== "Detected" ? video.resolution : "Direct";
      
      let displayTitle = getFilenameFromUrl(video.url);
      let isYoutube = video.url && (video.url.includes("googlevideo.com") || video.url.includes("youtube.com"));
      if (isYoutube && video.pageTitle) {
        displayTitle = `${video.pageTitle} (${res})`;
      }
      
      const downloadText = isYoutube ? `Download (${ext})` : `Download ${ext}`;
      
      card.innerHTML = `
        <div class="video-info">
          ${previewMarkup}
          <div class="video-meta">
            <div class="video-title" style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${displayTitle}</div>
            <div class="video-domain" style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
              ${isYoutube ? "YouTube Stream | " : ""}<span class="video-size">${sizeText}</span>
            </div>
          </div>
        </div>
        <button class="btn btn-primary download-action-btn">
          ${downloadText}
        </button>
      `;

      card.querySelector(".download-action-btn").addEventListener("click", () => {
        if (video.audioUrl) {
          startCombinedMediaDownload(video);
        } else {
          startDirectDownload(video);
        }
      });
      card.addEventListener("click", (e) => {
        if (!e.target.classList.contains("download-action-btn")) {
          if (video.audioUrl) {
            startCombinedMediaDownload(video);
          } else {
            startDirectDownload(video);
          }
        }
      });
    }

    videoList.appendChild(card);
    requestVideoPreview(card, video);
  });
}

function createPreviewMarkup(video) {
  const thumbnail = getVideoThumbnail(video);
  const imageMarkup = thumbnail
    ? `<img class="video-preview-image" src="${escapeAttribute(thumbnail)}" alt="">`
    : "";

  return `
    <div class="video-preview">
      ${imageMarkup}
      <div class="video-preview-fallback">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="23 7 16 12 23 17 23 7"></polygon>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
        </svg>
      </div>
    </div>
  `;
}

function getVideoThumbnail(video) {
  if (video.thumbnail) return video.thumbnail;

  try {
    const url = new URL(video.url);
    const youtubeId = getYoutubeId(url);
    if (youtubeId) {
      return `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`;
    }
  } catch (e) {}

  return null;
}

function getYoutubeId(url) {
  if (url.hostname.includes("youtube.com")) {
    if (url.pathname.startsWith("/embed/")) {
      return url.pathname.split("/embed/")[1].split("/")[0];
    }
    return url.searchParams.get("v");
  }
  if (url.hostname.includes("youtu.be")) {
    return url.pathname.slice(1).split("/")[0];
  }
  return null;
}

function requestVideoPreview(card, video) {
  if (!activeTabId || getVideoThumbnail(video)) return;

  chrome.tabs.sendMessage(activeTabId, { action: "get_video_preview", url: video.url }, (response) => {
    if (chrome.runtime.lastError || !response || !response.preview) return;

    const preview = card.querySelector(".video-preview");
    if (!preview || preview.querySelector(".video-preview-image")) return;

    const img = document.createElement("img");
    img.className = "video-preview-image";
    img.alt = "";
    img.src = response.preview;
    preview.prepend(img);
  });
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function getCardSizeText(video, duration = 0) {
  if (video.sizeBytes) {
    return `Size: ${formatMegabytes(video.sizeBytes)}`;
  }

  if (video.type === "hls") {
    const bandwidth = getBestHlsBandwidth(video);
    if (bandwidth) {
      return `Size: ${estimateSizeText(bandwidth, duration)}`;
    }
  }

  return "Size: unknown";
}

function getBestHlsBandwidth(video) {
  if (!video.qualities || video.qualities.length === 0) return 0;

  return video.qualities.reduce((best, quality) => {
    return Math.max(best, Number(quality.bandwidth) || 0);
  }, 0);
}

function updateHlsCardSize(card, video) {
  if (video.type !== "hls" || !activeTabId || !getBestHlsBandwidth(video)) return;

  chrome.tabs.sendMessage(activeTabId, { action: "get_video_duration" }, (response) => {
    if (chrome.runtime.lastError) return;

    const duration = (response && response.duration) ? response.duration : 0;
    if (!duration) return;

    const sizeEl = card.querySelector(".video-size");
    if (sizeEl) {
      sizeEl.textContent = getCardSizeText(video, duration);
    }
  });
}

function formatMegabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function triggerDirectDownload(url) {
  console.log(`[Downloader] Starting direct download for URL: ${url}`);
  chrome.downloads.download({
    url: url,
    saveAs: true
  }, () => {
    window.close();
  });
}

// Parses default download filename from direct URL paths
function getFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    return filename ? decodeURIComponent(filename) : "video.mp4";
  } catch (e) {
    return "video.mp4";
  }
}

// Estimates file size based on bandwidth and video duration (defaults to 1h average if duration is unavailable)
function estimateSizeText(bandwidth, duration) {
  if (!bandwidth) return "";
  
  const secs = (duration && duration > 0) ? duration : 3600;
  const isEstimatePerHour = !duration || duration === 0;

  const bytes = (bandwidth / 8) * secs;
  const mb = bytes / (1024 * 1024);
  
  const formatted = `${Math.round(mb)} MB`;
  
  return isEstimatePerHour ? `~${formatted}/hr` : `~${formatted}`;
}

// Opens the quality picker modal, queries video duration from content script, and lists HLS qualities with sizes
async function handleHlsCardClick(video) {
  try {
    console.log("[Popup] Querying active video duration for size estimation...");
    qualityDialog.classList.remove("hidden");
    qualityOptions.innerHTML = "<div class='state-desc' style='padding: 20px 0; text-align: center;'>Parsing qualities...</div>";

    // Query active video duration from content script context
    chrome.tabs.sendMessage(activeTabId, { action: "get_video_duration" }, async (response) => {
      const duration = (response && response.duration) ? response.duration : 0;
      
      try {
        const qualities = await parseM3U8(video.url, activeTabId);
        
        if (qualities.length === 0) {
          qualityOptions.innerHTML = "";
          createModalOptionButton("Auto Quality", "Auto", "", () => {
            qualityDialog.classList.add("hidden");
            startHlsDownload(video.url, "Auto");
          });
        } else {
          // Sort HLS quality list in descending order (highest resolution first)
          const sortedQualities = [...qualities].sort((q1, q2) => {
            const r1 = parseInt(q1.resolution) || 0;
            const r2 = parseInt(q2.resolution) || 0;
            return r2 - r1;
          });

          qualityOptions.innerHTML = "";
          sortedQualities.forEach((q) => {
            const sizeText = estimateSizeText(q.bandwidth, duration);
            createModalOptionButton(q.quality, q.resolution, sizeText, () => {
              qualityDialog.classList.add("hidden");
              startHlsDownload(video.url, q.quality);
            });
          });
        }
      } catch (err) {
        console.error("[Popup] HLS manifest parse failed inside content callback:", err);
        fallbackHlsDownload(video.url);
      }
    });
  } catch (e) {
    console.error("[Popup] HLS card click failed:", e);
    fallbackHlsDownload(video.url);
  }
}

function fallbackHlsDownload(url) {
  qualityOptions.innerHTML = "";
  createModalOptionButton("Auto Quality", "Auto", "", () => {
    qualityDialog.classList.add("hidden");
    startHlsDownload(url, "Auto");
  });
}

// Injects option buttons in modal with estimated sizes
function createModalOptionButton(qualityTitle, resolution, estimatedSize, onClick) {
  const btn = document.createElement("button");
  btn.className = "quality-option-btn";
  
  const sizeDisplay = estimatedSize 
    ? `<span style="font-size: 11px; color: var(--text-secondary); font-weight: normal; margin-left: 8px;">(${estimatedSize})</span>` 
    : "";

  btn.innerHTML = `
    <span style="font-weight: 600; color: var(--text-primary);">${qualityTitle}${sizeDisplay}</span>
    <span class="quality-res" style="font-size: 11px; color: var(--accent-primary);">${resolution}</span>
  `;
  btn.addEventListener("click", onClick);
  qualityOptions.appendChild(btn);
}

function startHlsDownload(m3u8Url, qualityTitle) {
  chrome.runtime.sendMessage({
    action: "start_hls_download",
    tabId: activeTabId,
    url: m3u8Url,
    qualityTitle: qualityTitle
  });
  showDownloadProgress(0);
}

function startCombinedMediaDownload(video) {
  chrome.runtime.sendMessage({
    action: "start_combined_media_download",
    tabId: activeTabId,
    videoUrl: video.url,
    audioUrl: video.audioUrl,
    pageTitle: video.pageTitle || getFilenameFromUrl(video.url)
  });
  showDownloadProgress(0);
}

function startDirectDownload(video) {
  chrome.runtime.sendMessage({
    action: "start_direct_download",
    tabId: activeTabId,
    url: video.url,
    pageTitle: video.pageTitle || getFilenameFromUrl(video.url)
  });
  showDownloadProgress(0);
}

function cancelDownload() {
  chrome.runtime.sendMessage({ action: "cancel_hls_download", tabId: activeTabId }, () => {
    hideDownloadProgress();
    refreshVideoList();
  });
}

// Helper to format bytes to MB/GB
function formatBytes(bytes) {
  if (!bytes) return "0.0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

// Updates the inline download progress banner
function showDownloadProgress(progress) {
  downloadProgressBanner.classList.remove("hidden");
  
  let percentage = 0;
  let bytes = 0;
  
  if (typeof progress === "object" && progress !== null) {
    percentage = progress.percentage || 0;
    bytes = progress.downloadedBytes || 0;
  } else {
    percentage = progress || 0;
  }
  
  bannerPercentage.innerText = formatBytes(bytes);
  bannerBarFill.style.width = `${percentage}%`;
  
  if (percentage < 100) {
    bannerDetail.innerHTML = `Fetching segment chunks... (${percentage}%)`;
  } else {
    bannerDetail.innerHTML = `Assembly complete! Save prompted...`;
    setTimeout(hideDownloadProgress, 4000); // Auto-hide after 4 seconds
  }
}

// Hides the inline progress banner
function hideDownloadProgress() {
  downloadProgressBanner.classList.add("hidden");
}

// Listen to download progress and state reset notifications from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== activeTabId) return;

  if (message.action === "video_registry_cleared") {
    refreshVideoList();
  } else if (message.action === "download_progress_update") {
    showDownloadProgress(message.progress);
  } else if (message.action === "offscreen_download_complete") {
    hideDownloadProgress();
    refreshVideoList();
  } else if (message.action === "download_error") {
    alert(`Download error occurred: ${message.error}`);
    hideDownloadProgress();
    refreshVideoList();
  }
});

// Run
document.addEventListener("DOMContentLoaded", init);
