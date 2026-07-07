// popup.js
import { parseM3U8 } from './hls-parser.js';

let activeTabId = null;
let currentVideos = [];

// DOM Elements
const stateWaiting = document.getElementById("state-waiting");
const stateDetected = document.getElementById("state-detected");
const stateDownloading = document.getElementById("state-downloading");

const videoList = document.getElementById("video-list");
const cancelDownloadBtn = document.getElementById("cancel-download-btn");
const progressBarCircle = document.getElementById("progress-bar-circle");
const progressPercentage = document.getElementById("progress-percentage");
const downloadDetail = document.getElementById("download-detail");

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

  // 1. Check if there's an active download running for this tab
  chrome.runtime.sendMessage({ action: "get_download_progress", tabId: activeTabId }, (response) => {
    if (response && response.downloading) {
      showDownloadProgress(response.progress);
    } else {
      // 2. Fetch detected videos for the active tab
      refreshVideoList();
    }
  });

  // Setup static event listeners
  cancelDownloadBtn.addEventListener("click", cancelDownload);
  closeDialogBtn.addEventListener("click", () => qualityDialog.classList.add("hidden"));
}

// // Fetches list of detected HLS videos from background service worker
function refreshVideoList() {
  chrome.runtime.sendMessage({ action: "get_detected_videos", tabId: activeTabId }, async (response) => {
    if (response && response.videos && response.videos.length > 0) {
      // Filter list to HLS videos only (per user request)
      const hlsVideos = response.videos.filter(v => v.type === "hls");
      currentVideos = hlsVideos;
      
      if (hlsVideos.length > 0) {
        renderVideoCards(hlsVideos);
      } else {
        showState("waiting");
      }
    } else {
      showState("waiting");
    }
  });
}

function showState(state) {
  stateWaiting.classList.add("hidden");
  stateDetected.classList.add("hidden");
  stateDownloading.classList.add("hidden");

  if (state === "waiting") {
    stateWaiting.classList.remove("hidden");
  } else if (state === "detected") {
    stateDetected.classList.remove("hidden");
  } else if (state === "downloading") {
    stateDownloading.classList.remove("hidden");
  }
}

// Renders detected HLS streams as card items
function renderVideoCards(videos) {
  videoList.innerHTML = "";
  showState("detected");

  videos.forEach((video, index) => {
    const card = document.createElement("div");
    card.className = "video-card";
    
    card.innerHTML = `
      <div class="video-info">
        <div class="video-icon-wrapper">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>
        </div>
        <div class="video-meta">
          <div class="video-title" style="font-size: 14px; font-weight: 600; color: var(--accent-primary);">HLS Video (Multi-Quality)</div>
          <div class="video-domain" style="font-size: 11px; margin-top: 2px;">Select quality and download as MP4</div>
        </div>
      </div>
      <button class="btn btn-primary download-action-btn">
        Select Quality
      </button>
    `;

    // Click on the card or action button triggers the quality picker modal
    card.querySelector(".download-action-btn").addEventListener("click", () => {
      handleHlsCardClick(video);
    });
    card.addEventListener("click", (e) => {
      if (!e.target.classList.contains("download-action-btn")) {
        handleHlsCardClick(video);
      }
    });

    videoList.appendChild(card);
  });
}

// Opens the quality picker modal and fetches HLS qualities
async function handleHlsCardClick(video) {
  try {
    console.log("[Popup] Opening quality selector dialog...");
    qualityDialog.classList.remove("hidden");
    qualityOptions.innerHTML = "<div class='state-desc' style='padding: 20px 0; text-align: center;'>Parsing qualities...</div>";

    const qualities = await parseM3U8(video.url);
    
    if (qualities.length === 0) {
      // Fallback if parsing fails or has no multi-qualities
      qualityOptions.innerHTML = "";
      createModalOptionButton("Auto Quality", "Auto", () => {
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
        createModalOptionButton(q.quality, q.resolution, () => {
          qualityDialog.classList.add("hidden");
          startHlsDownload(video.url, q.quality);
        });
      });
    }
  } catch (e) {
    console.error("[Popup] HLS manifest parsing error:", e);
    qualityOptions.innerHTML = "";
    createModalOptionButton("Auto Quality", "Auto", () => {
      qualityDialog.classList.add("hidden");
      startHlsDownload(video.url, "Auto");
    });
  }
}

// Injects option buttons in modal
function createModalOptionButton(qualityTitle, resolution, onClick) {
  const btn = document.createElement("button");
  btn.className = "quality-option-btn";
  btn.innerHTML = `
    <span style="font-weight: 600; color: var(--text-primary);">${qualityTitle}</span>
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

function cancelDownload() {
  chrome.runtime.sendMessage({ action: "cancel_hls_download", tabId: activeTabId }, () => {
    refreshVideoList();
  });
}

// Updates circular progress indicator
function showDownloadProgress(progress) {
  showState("downloading");
  
  const percentage = progress || 0;
  progressPercentage.innerText = `${percentage}%`;
  
  // Calculate SVG circle dashoffset (radius = 50, circumference = 2 * PI * r = ~314.16)
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  
  progressBarCircle.style.strokeDashoffset = offset;
  
  if (percentage < 100) {
    downloadDetail.innerHTML = `Fetching segment chunks... (${percentage}%)<br><span style="font-size: 10px; color: var(--text-secondary); margin-top: 4px; display: inline-block;">Note: Streams save as .mp4 files.</span>`;
  } else {
    downloadDetail.innerHTML = `Assembly complete! Prompting save...<br><span style="font-size: 10px; color: var(--accent-primary); margin-top: 4px; display: inline-block;">Ready to play in all default media players!</span>`;
  }
}

// Listen to download progress notifications from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== activeTabId) return;

  if (message.action === "download_progress_update") {
    showDownloadProgress(message.progress);
  } else if (message.action === "download_error") {
    alert(`Download error occurred: ${message.error}`);
    refreshVideoList();
  }
});

// Run
document.addEventListener("DOMContentLoaded", init);
