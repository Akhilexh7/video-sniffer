// popup.js
import { parseM3U8 } from './hls-parser.js';

let activeTabId = null;
let activeTabUrl = "";
let currentVideos = [];

// DOM Elements
const stateWaiting = document.getElementById("state-waiting");
const stateDetected = document.getElementById("state-detected");
const videoList = document.getElementById("video-list");
const youtubeSection = document.getElementById("youtube-section");
const youtubeList = document.getElementById("youtube-list");
const genericSection = document.getElementById("generic-section");

// Inline Download Banner Elements
const downloadProgressBanner = document.getElementById("download-progress-banner");
const bannerPercentage = document.getElementById("banner-percentage");
const bannerBarFill = document.getElementById("banner-bar-fill");
const bannerDetail = document.getElementById("banner-detail");
const bannerCancelBtn = document.getElementById("banner-cancel-btn");

const qualityDialog = document.getElementById("quality-dialog");
const qualityOptions = document.getElementById("quality-options");
const closeDialogBtn = document.getElementById("close-dialog-btn");

// Backend Control Elements
const backendStatusDot = document.getElementById("backend-status-dot");
const toggleBackendBtn = document.getElementById("toggle-backend-btn");

// Custom Alert Dialog Elements
const alertDialog = document.getElementById("alert-dialog");
const alertMessage = document.getElementById("alert-message");
const alertOkBtn = document.getElementById("alert-ok-btn");

function showCustomAlert(message) {
  if (!alertDialog || !alertMessage || !alertOkBtn) {
    alert(message);
    return;
  }
  alertMessage.innerText = message;
  alertDialog.classList.remove("hidden");
  
  // Clone button to strip old listeners
  const newBtn = alertOkBtn.cloneNode(true);
  alertOkBtn.parentNode.replaceChild(newBtn, alertOkBtn);
  
  newBtn.addEventListener("click", () => {
    alertDialog.classList.add("hidden");
  });
}

// Initialize popup
async function init() {
  console.log("[Detector] Popup opened.");
  
  // Get current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTabId = tab.id;
  activeTabUrl = tab.url || "";

  // 1. Initialize backend controls
  if (toggleBackendBtn) {
    toggleBackendBtn.addEventListener("click", handleToggleBackend);
    updateBackendStatusUI();
  }

  // 2. Fetch detected videos for the active tab (unconditional, so they stay visible)
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
  qualityDialog.addEventListener("click", (e) => {
    if (e.target === qualityDialog) {
      qualityDialog.classList.add("hidden");
    }
  });

  const deepScanBtn = document.getElementById("deep-scan-btn");
  const waitingDeepScanBtn = document.getElementById("waiting-deep-scan-btn");
  if (deepScanBtn) deepScanBtn.addEventListener("click", triggerDeepScan);
  if (waitingDeepScanBtn) waitingDeepScanBtn.addEventListener("click", triggerDeepScan);
}

async function triggerDeepScan() {
  const deepScanBtn = document.getElementById("deep-scan-btn");
  const waitingDeepScanBtn = document.getElementById("waiting-deep-scan-btn");
  
  const setScanning = (scanning) => {
    if (deepScanBtn) {
      deepScanBtn.disabled = scanning;
      deepScanBtn.innerText = scanning ? "Scanning..." : "Deep Scan";
    }
    if (waitingDeepScanBtn) {
      waitingDeepScanBtn.disabled = scanning;
      waitingDeepScanBtn.innerText = scanning ? "Scanning..." : "Deep Scan";
    }
  };

  if (!activeTabId) return;

  setScanning(true);
  console.log("[Popup] Triggering Deep Scan in active tab...");

  chrome.tabs.sendMessage(activeTabId, { action: "run_deep_scan" }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("[Popup] Content script unreachable, re-injecting...", chrome.runtime.lastError.message);
      chrome.scripting.executeScript(
        { target: { tabId: activeTabId }, files: ["content.js"] },
        () => {
          if (chrome.runtime.lastError) {
            console.error("[Popup] Content script re-injection failed:", chrome.runtime.lastError.message);
            setScanning(false);
            return;
          }
          // Retry once after injection
          chrome.tabs.sendMessage(activeTabId, { action: "run_deep_scan" }, (retryResponse) => {
            setScanning(false);
            if (chrome.runtime.lastError) {
              console.error("[Popup] Deep scan retry failed:", chrome.runtime.lastError.message);
              return;
            }
            renderVideoCards(retryResponse?.videos || []);
          });
        }
      );
      return;
    }
    setScanning(false);
    console.log("[Popup] Deep scan completed successfully.");
    renderVideoCards(response?.videos || []);
  });
}

function refreshVideoList() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) {
      activeTabUrl = tab.url || "";
    }
    chrome.runtime.sendMessage({ action: "get_detected_videos", tabId: activeTabId }, async (response) => {
      if (response && response.videos && response.videos.length > 0) {
        const sortedVideos = sortVideosBySize(response.videos);
        currentVideos = sortedVideos;
        renderVideoCards(sortedVideos);
      } else {
        showState("waiting");
      }
    });
  });
}

function showState(state) {
  stateWaiting.classList.add("hidden");
  stateDetected.classList.add("hidden");

  const appMain = document.querySelector(".app-main");

  if (state === "waiting") {
    stateWaiting.classList.remove("hidden");
    if (appMain) appMain.style.overflowY = "hidden";
  } else if (state === "detected") {
    stateDetected.classList.remove("hidden");
    if (appMain) appMain.style.overflowY = "auto";
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
  console.log("[Popup] renderVideoCards called. Videos:", videos);
  videoList.innerHTML = "";
  youtubeList.innerHTML = "";
  
  if (!videos || videos.length === 0) {
    showState("waiting");
    return;
  }

  showState("detected");

  const detectedCountEl = document.getElementById("detected-count");
  if (detectedCountEl) {
    detectedCountEl.innerText = videos.length;
  }

  const createCard = (video) => {
    const card = document.createElement("div");
    card.className = "video-card";
    const previewMarkup = createPreviewMarkup(video);
    
    if (video.type === "hls" || video.type === "youtube") {
      const displayTitle = video.type === "youtube" ? (video.pageTitle || video.title || "YouTube Video") : (video.pageTitle || "HLS Video Stream");
      const badgeClass = video.type.toLowerCase();
      const badgeText = video.type === "youtube" ? "YouTube" : "HLS";
      const errorIndicator = video.parseError 
        ? `<div style="font-size: 10px; color: #ef4444; margin-top: 2px; font-weight: 500;">⚠️ Parse failed: ${video.parseError}</div>`
        : "";
      
      card.innerHTML = `
        <div class="video-info">
          ${previewMarkup}
          <div class="video-meta">
            <div class="video-title" style="font-size: 14px; font-weight: 600; color: var(--accent-primary);">${displayTitle}</div>
            <div class="video-domain" style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
              <span class="video-type-badge ${badgeClass}">${badgeText}</span> <span style="vertical-align: middle;">Multi-Quality Stream</span>
            </div>
            ${errorIndicator}
          </div>
        </div>
        <button class="btn btn-primary download-action-btn">
          Select Quality
        </button>
      `;

      card.querySelector(".download-action-btn").addEventListener("click", () => {
        handleMultiQualityCardClick(video);
      });
      card.addEventListener("click", (e) => {
        if (!e.target.classList.contains("download-action-btn")) {
          handleMultiQualityCardClick(video);
        }
      });
    } else {
      const sizeText = getCardSizeText(video);
      const ext = video.type.toLowerCase();
      const rawRes = video.resolution !== "Detected" ? video.resolution : "Direct";
      const res = getFormattedResolution(rawRes) || rawRes;
      
      let displayTitle = video.pageTitle || getFilenameFromUrl(video.url);
      if (displayTitle === "Video Stream" && video.url) {
        displayTitle = getFilenameFromUrl(video.url);
      }
      
      let isYoutube = video.url && (
        video.url.includes("googlevideo.com") || 
        video.url.includes("youtube.com") || 
        video.url.includes("youtu.be") || 
        video.url.includes("youtube-nocookie.com")
      );
      if (res && res !== "Direct" && res !== "Auto") {
        displayTitle = `${displayTitle} (${res})`;
      }
      
      const downloadText = isYoutube ? `Download (${ext.toUpperCase()})` : `Download ${ext.toUpperCase()}`;
      const qualityLabel = (res && res !== "Direct" && res !== "Auto") ? ` &middot; ${res}` : "";
      
      const isSizeKnown = !sizeText.includes("Unknown");
      const sizeMarkup = isSizeKnown
        ? `<span class="size-highlight" style="color: var(--accent-secondary); font-weight: 600;">${sizeText}</span>`
        : `<span>${sizeText}</span>`;

      if (video.audioUrl) {
        card.innerHTML = `
          <div class="video-info">
            ${previewMarkup}
            <div class="video-meta">
              <div class="video-title" style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${displayTitle}</div>
              <div class="video-domain" style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                <span class="video-type-badge ${ext}">${ext.toUpperCase()}</span> <span style="vertical-align: middle;">${isYoutube ? "YouTube Stream | " : ""}${sizeMarkup}${qualityLabel}</span>
              </div>
            </div>
          </div>
          <div class="card-actions" style="display: flex; gap: 8px; width: 100%;">
            <button class="btn btn-primary download-combined-btn" style="flex: 1; font-size: 11px; padding: 6px 12px; border-radius: 6px; font-weight: 600;">
              Merge + Audio
            </button>
            <button class="btn btn-secondary download-video-btn" style="flex: 1; font-size: 11px; padding: 6px 12px; border-radius: 6px; font-weight: 600; border: 1px solid rgba(255, 255, 255, 0.25);">
              Video Only
            </button>
          </div>
        `;

        card.querySelector(".download-combined-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          startCombinedMediaDownload(video);
        });
        card.querySelector(".download-video-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          startDirectDownload(video);
        });
      } else {
        card.innerHTML = `
          <div class="video-info">
            ${previewMarkup}
            <div class="video-meta">
              <div class="video-title" style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${displayTitle}</div>
              <div class="video-domain" style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                <span class="video-type-badge ${ext}">${ext.toUpperCase()}</span> <span style="vertical-align: middle;">${isYoutube ? "YouTube Stream | " : ""}${sizeMarkup}${qualityLabel}</span>
              </div>
            </div>
          </div>
          <button class="btn btn-primary download-action-btn" style="border-radius: 6px; font-weight: 600; padding: 6px 12px; font-size: 11px;">
            ${downloadText}
          </button>
        `;

        card.querySelector(".download-action-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          startDirectDownload(video);
        });
      }
    }

    requestVideoPreview(card, video);
    return card;
  };

  const populateList = (container, videosList) => {
    container.innerHTML = "";
    const primaryVideos = videosList.slice(0, 3);
    const secondaryVideos = videosList.slice(3);

    primaryVideos.forEach((video) => {
      container.appendChild(createCard(video));
    });

    if (secondaryVideos.length > 0) {
      const toggleContainer = document.createElement("div");
      toggleContainer.className = "collapsed-videos-container";
      toggleContainer.style.marginTop = "12px";
      toggleContainer.style.marginBottom = "8px";

      const toggleButton = document.createElement("button");
      toggleButton.className = "btn btn-secondary";
      toggleButton.style.display = "flex";
      toggleButton.style.justifyContent = "center";
      toggleButton.style.alignItems = "center";
      toggleButton.style.gap = "6px";
      toggleButton.innerHTML = `
        <span>Show all (${secondaryVideos.length} more)</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s;">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      `;

      const collapsedContent = document.createElement("div");
      collapsedContent.className = "collapsed-content hidden";
      collapsedContent.style.marginTop = "10px";
      collapsedContent.style.display = "flex";
      collapsedContent.style.flexDirection = "column";
      collapsedContent.style.gap = "10px";

      secondaryVideos.forEach((video) => {
        collapsedContent.appendChild(createCard(video));
      });

      toggleButton.addEventListener("click", () => {
        const isHidden = collapsedContent.classList.contains("hidden");
        const svg = toggleButton.querySelector("svg");
        if (isHidden) {
          collapsedContent.classList.remove("hidden");
          collapsedContent.style.display = "flex";
          toggleButton.querySelector("span").textContent = "Hide extra videos";
          if (svg) svg.style.transform = "rotate(180deg)";
        } else {
          collapsedContent.classList.add("hidden");
          collapsedContent.style.display = "none";
          toggleButton.querySelector("span").textContent = `Show all (${secondaryVideos.length} more)`;
          if (svg) svg.style.transform = "rotate(0deg)";
        }
      });

      toggleContainer.appendChild(toggleButton);
      toggleContainer.appendChild(collapsedContent);
      container.appendChild(toggleContainer);
      
      collapsedContent.style.display = "none";
    }
  };

  const isOnYoutubePage = activeTabUrl && (activeTabUrl.includes("youtube.com") || activeTabUrl.includes("youtu.be"));

  const isYoutubeVideo = (v) => {
    if (v.type === "youtube") return true;
    if (isOnYoutubePage) return true; // Categorize everything under YouTube Downloads if we are on a YouTube host page
    if (!v.url) return false;
    const urlLower = v.url.toLowerCase();
    return urlLower.includes("youtube.com") || 
           urlLower.includes("youtu.be") || 
           urlLower.includes("googlevideo.com") || 
           urlLower.includes("youtube-nocookie.com");
  };

  const youtubeVideos = videos.filter(isYoutubeVideo);
  const genericVideos = videos.filter(v => !isYoutubeVideo(v));

  if (youtubeVideos.length > 0) {
    populateList(youtubeList, youtubeVideos);
  } else {
    youtubeList.innerHTML = `<div class="state-desc" style="padding: 10px 0; text-align: left; font-size: 11px; color: var(--text-tertiary);">No YouTube videos detected on this page.</div>`;
  }

  if (genericVideos.length > 0) {
    populateList(videoList, genericVideos);
  } else {
    videoList.innerHTML = `<div class="state-desc" style="padding: 10px 0; text-align: left; font-size: 11px; color: var(--text-tertiary);">No browser detections on this page.</div>`;
  }
}

function createPreviewMarkup(video) {
  const thumbnail = getVideoThumbnail(video);
  const imageMarkup = thumbnail
    ? `<img class="video-preview-image" src="${escapeAttribute(thumbnail)}" onerror="this.style.display='none'; this.onerror=null;" alt="">`
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
    img.onerror = () => {
      img.style.display = "none";
      img.onerror = null;
    };
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

function formatMegabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function estimateSizeText(bandwidth, duration) {
  if (!bandwidth) return "";
  
  const secs = (duration && duration > 0) ? duration : 3600;
  const isEstimatePerHour = !duration || duration === 0;

  const bytes = (bandwidth / 8) * secs;
  const mb = bytes / (1024 * 1024);
  
  const formatted = `${Math.round(mb)} MB`;
  
  return isEstimatePerHour ? `~${formatted}/hr` : `~${formatted}`;
}

function getFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    return filename ? decodeURIComponent(filename) : "video.mp4";
  } catch (e) {
    return "video.mp4";
  }
}

// Opens the quality picker modal, queries video duration from content script, and lists HLS or YouTube qualities
async function handleMultiQualityCardClick(video) {
  try {
    qualityDialog.classList.remove("hidden");
    qualityOptions.innerHTML = "<div class='state-desc' style='padding: 20px 0; text-align: center;'>Parsing qualities...</div>";

    if (video.type === "youtube") {
      qualityOptions.innerHTML = "<div class='state-desc' style='padding: 20px 0; text-align: center; font-size: 12px; color: var(--text-secondary);'>Analyzing available qualities...</div>";
      
      const renderFallback = () => {
        qualityOptions.innerHTML = "";
        const stdQualities = [
          { label: "Best Quality (Default)", res: "Best" },
          { label: "1080p (Full HD)", res: "1080p" },
          { label: "720p (HD)", res: "720p" },
          { label: "480p (Standard)", res: "480p" },
          { label: "360p (Low)", res: "360p" }
        ];

        stdQualities.forEach((q) => {
          createModalOptionButton(
            q.label, 
            q.res, 
            "", 
            () => {
              qualityDialog.classList.add("hidden");
              startYoutubeDownload(null, null, video.pageTitle || video.title || "YouTube Video", q.res, video.frameId || null, activeTabUrl || video.url);
            }
          );
        });
      };

      const targetUrl = video.url || activeTabUrl;
      fetch(`http://localhost:3000/api/youtube-formats?url=${encodeURIComponent(targetUrl)}`)
        .then(res => {
          if (!res.ok) throw new Error("HTTP error " + res.status);
          return res.json();
        })
        .then(data => {
          if (data && data.qualities && data.qualities.length > 0) {
            qualityOptions.innerHTML = "";
            data.qualities.forEach((q) => {
              createModalOptionButton(
                q.label, 
                q.resolution, 
                "", 
                () => {
                  qualityDialog.classList.add("hidden");
                  startYoutubeDownload(null, null, video.pageTitle || video.title || "YouTube Video", q.resolution, video.frameId || null, activeTabUrl || video.url);
                }
              );
            });
          } else {
            renderFallback();
          }
        })
        .catch(err => {
          console.warn("[Popup] Failed to fetch real YouTube formats, falling back:", err);
          renderFallback();
        });
      return;
    }

    console.log("[Popup] Querying active video duration for size estimation...");
    chrome.tabs.sendMessage(activeTabId, { action: "get_video_duration" }, async (response) => {
      const duration = (response && response.duration) ? response.duration : 0;
      
      try {
        const qualities = await parseM3U8(video.url, activeTabId, video.frameId);
        
        if (qualities.length === 0) {
          qualityOptions.innerHTML = "";
          createModalOptionButton("Auto Quality", "Auto", "", () => {
            qualityDialog.classList.add("hidden");
            startHlsDownload(video.url, "Auto", video.frameId || null);
          });
        } else {
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
              startHlsDownload(video.url, q.quality, video.frameId || null);
            });
          });
        }
      } catch (err) {
        console.error("[Popup] HLS manifest parse failed inside content callback:", err);
        fallbackHlsDownload(video);
      }
    });
  } catch (e) {
    console.error("[Popup] Multi quality card click failed:", e);
    fallbackHlsDownload(video);
  }
}

function fallbackHlsDownload(video) {
  qualityOptions.innerHTML = "";
  createModalOptionButton("Auto Quality", "Auto", "", () => {
    qualityDialog.classList.add("hidden");
    startHlsDownload(video.url, "Auto", video.frameId || null);
  });
}

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

function startHlsDownload(m3u8Url, qualityTitle, frameId) {
  chrome.runtime.sendMessage({
    action: "start_hls_download",
    tabId: activeTabId,
    url: m3u8Url,
    qualityTitle: qualityTitle,
    frameId: frameId
  });
  showDownloadProgress(0);
}

function startYoutubeDownload(videoUrl, audioUrl, pageTitle, resolution, frameId, youtubeUrl = null) {
  chrome.runtime.sendMessage({ action: "get_backend_status" }, (response) => {
    const running = response && response.running;
    if (!running) {
      showCustomAlert("Please start the backend server first by clicking the 'Start Backend' button in the top-right corner.");
      return;
    }
    
    let title = pageTitle || "youtube_video";
    if (resolution) {
      title = `${title}_${resolution}`;
    }
    chrome.runtime.sendMessage({
      action: "start_youtube_download",
      tabId: activeTabId,
      videoUrl: videoUrl,
      audioUrl: audioUrl,
      pageTitle: title,
      resolution: resolution,
      frameId: frameId,
      youtubeUrl: youtubeUrl
    });
    showDownloadProgress(0);
  });
}

function startCombinedMediaDownload(video) {
  const rawRes = video.resolution !== "Detected" ? video.resolution : "Direct";
  const res = getFormattedResolution(rawRes) || rawRes;
  let title = video.pageTitle || getFilenameFromUrl(video.url);
  if (res && res !== "Direct" && res !== "Auto") {
    title = `${title}_${res}`;
  }
  chrome.runtime.sendMessage({
    action: "start_combined_media_download",
    tabId: activeTabId,
    videoUrl: video.url,
    audioUrl: video.audioUrl,
    pageTitle: title,
    frameId: video.frameId || null
  });
  showDownloadProgress(0);
}

// In popup.js, getFormattedResolution resolves actual dimensions into standard labels
function getFormattedResolution(res) {
  if (!res || res === "Detected" || res === "Direct" || res === "Auto") return "";
  if (res.includes("x")) {
    const parts = res.split("x");
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);
    if (!isNaN(width) && !isNaN(height)) {
      return `${Math.min(width, height)}p`;
    }
  }
  return res;
}

function startDirectDownload(video) {
  const rawRes = video.resolution !== "Detected" ? video.resolution : "Direct";
  const res = getFormattedResolution(rawRes) || rawRes;
  let title = video.pageTitle || getFilenameFromUrl(video.url);
  if (res && res !== "Direct" && res !== "Auto") {
    title = `${title}_${res}`;
  }
  chrome.runtime.sendMessage({
    action: "start_direct_download",
    tabId: activeTabId,
    url: video.url,
    pageTitle: title,
    expectedSize: video.sizeBytes || null,
    frameId: video.frameId || null
  });
  showDownloadProgress(0);
}

function cancelDownload() {
  chrome.runtime.sendMessage({ action: "cancel_hls_download", tabId: activeTabId }, () => {
    hideDownloadProgress();
    refreshVideoList();
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0.0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function showDownloadProgress(progress) {
  downloadProgressBanner.classList.remove("hidden");
  
  let percentage = 0;
  let bytes = 0;
  let totalBytes = null;
  
  if (typeof progress === "object" && progress !== null) {
    percentage = progress.percentage || 0;
    bytes = progress.downloadedBytes || 0;
    totalBytes = progress.totalBytes;
  } else {
    percentage = progress || 0;
  }
  
  const downloadedText = formatBytes(bytes);
  const totalText = totalBytes ? formatBytes(totalBytes) : "?";
  bannerPercentage.innerText = `${downloadedText} / ${totalText}`;
  
  const pctString = `${percentage}%`;
  bannerBarFill.style.width = pctString;
  
  // Drive scrubber tooltip via custom properties and data attributes
  const trackEl = downloadProgressBanner.querySelector(".banner-bar-bg");
  if (trackEl) {
    trackEl.style.setProperty("--progress-pct", pctString);
    trackEl.setAttribute("data-percentage", pctString);
  }
  
  if (typeof progress === "object" && progress !== null) {
    if (progress.status === "muxing") {
      bannerDetail.innerText = "Muxing audio and video... (please wait)";
    } else if (progress.status === "completed") {
      bannerDetail.innerHTML = `Assembly complete! Save prompted...`;
      setTimeout(hideDownloadProgress, 4000); // Auto-hide after 4 seconds
    } else if (progress.statusText) {
      bannerDetail.innerText = progress.statusText;
    } else if (progress.segmentIndex !== undefined) {
      bannerDetail.innerText = `Downloading segment ${progress.segmentIndex + 1} of ${progress.totalSegments}`;
    } else {
      bannerDetail.innerText = "Downloading media streams...";
    }
  }
}

function hideDownloadProgress() {
  downloadProgressBanner.classList.add("hidden");
}

// Listen to download progress and state reset notifications from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "backend_status_changed") {
    updateBackendStatusUI();
    return;
  }

  if (message.tabId !== activeTabId) return;

  if (message.action === "video_registry_cleared" || message.action === "video_registry_updated") {
    refreshVideoList();
  } else if (message.action === "download_progress_update") {
    showDownloadProgress(message.progress);
  } else if (message.action === "offscreen_download_complete") {
    hideDownloadProgress();
    refreshVideoList();
  } else if (message.action === "download_error") {
    showCustomAlert(`Download error occurred: ${message.error}`);
    hideDownloadProgress();
    refreshVideoList();
  }
});

function updateBackendStatusUI() {
  if (!backendStatusDot || !toggleBackendBtn) return;
  chrome.runtime.sendMessage({ action: "get_backend_status" }, (response) => {
    const running = response && response.running;
    if (running) {
      backendStatusDot.style.background = "#2ecc71"; // green
      toggleBackendBtn.innerText = "Stop Backend (Port 3000)";
      toggleBackendBtn.style.background = "rgba(46, 204, 113, 0.15)";
      toggleBackendBtn.style.borderColor = "rgba(46, 204, 113, 0.3)";
    } else {
      backendStatusDot.style.background = "#ff4d4d"; // red
      toggleBackendBtn.innerText = "Start Backend";
      toggleBackendBtn.style.background = "rgba(255, 255, 255, 0.08)";
      toggleBackendBtn.style.borderColor = "rgba(255, 255, 255, 0.15)";
    }
    toggleBackendBtn.disabled = false;
  });
}

function handleToggleBackend() {
  if (!toggleBackendBtn) return;
  toggleBackendBtn.disabled = true;
  
  chrome.runtime.sendMessage({ action: "get_backend_status" }, (response) => {
    const running = response && response.running;
    const action = running ? "stop_backend" : "start_backend";
    
    toggleBackendBtn.innerText = running ? "Stopping..." : "Starting...";
    
    chrome.runtime.sendMessage({ action }, (res) => {
      if (res && !res.success && res.error) {
        showCustomAlert(`Failed to configure backend: ${res.error}\n\nPlease double-click "install-host.bat" inside the "extension/backend" folder to register the messaging host.`);
      }
      setTimeout(updateBackendStatusUI, 500);
    });
  });
}

// Run
document.addEventListener("DOMContentLoaded", init);
