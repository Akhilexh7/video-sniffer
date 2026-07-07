// content.js
console.log("[Detector] Content script injected on page:", window.location.href);

// Scan the page for video elements and sources
function scanPageForVideos() {
  const videos = document.querySelectorAll("video");
  videos.forEach((video) => {
    handleVideoElement(video);
  });

  // Also check if there are source tags
  const sources = document.querySelectorAll("video source");
  sources.forEach((source) => {
    if (source.src) {
      reportVideo(source.src, "source");
    }
  });

  // Check iframe elements (like Vimeo/YouTube embeds)
  const iframes = document.querySelectorAll("iframe");
  iframes.forEach((iframe) => {
    if (iframe.src && (iframe.src.includes("youtube.com/embed/") || iframe.src.includes("player.vimeo.com/video/"))) {
      reportVideo(iframe.src, "iframe");
    }
  });
}

function handleVideoElement(video) {
  // Skip silent looping previews (e.g. video thumbnails on hover)
  if (video.loop && video.muted && !video.controls) {
    console.log("[Detector] Skipping muted looping preview video tag.");
    return;
  }

  // Skip tiny preview cards or ad players (width/height under 200px)
  if (video.offsetWidth > 0 && video.offsetWidth < 200) {
    console.log("[Detector] Skipping small preview thumbnail video tag.");
    return;
  }

  if (video.src) {
    reportVideo(video.src, "video");
  }

  // Monitor for changes in the src attribute of this video element
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === "src" && video.src) {
        // Re-evaluate filters on dynamic src load
        if (video.loop && video.muted && !video.controls) return;
        if (video.offsetWidth > 0 && video.offsetWidth < 200) return;
        
        reportVideo(video.src, "video_changed");
      }
    });
  });
  observer.observe(video, { attributes: true, attributeFilter: ["src"] });
}

// Reports the video to background.js
function reportVideo(url, source) {
  if (!url) return;
  
  // Ignore Blob URLs since background.js catches their underlying network requests (HLS/DASH/MP4)
  if (url.startsWith("blob:")) return;

  const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
  let type = null;
  let title = "";

  if (cleanUrl.includes(".m3u8")) {
    type = "hls";
    title = "HLS Video (Multi-Quality)";
  } else if (cleanUrl.includes(".mpd")) {
    type = "dash";
    title = "DASH Video (Adaptive Quality)";
  } else if (cleanUrl.endsWith(".mp4")) {
    type = "mp4";
    title = "MP4 Video";
  } else if (cleanUrl.endsWith(".webm")) {
    type = "webm";
    title = "WebM Video";
  } else if (cleanUrl.endsWith(".mkv")) {
    type = "mkv";
    title = "MKV Video";
  } else if (cleanUrl.endsWith(".flv")) {
    type = "flv";
    title = "FLV Video";
  } else if (cleanUrl.endsWith(".avi")) {
    type = "avi";
    title = "AVI Video";
  } else if (cleanUrl.endsWith(".mov")) {
    type = "mov";
    title = "MOV Video";
  } else if (cleanUrl.endsWith(".3gp")) {
    type = "3gp";
    title = "3GP Video";
  } else if (url.includes("youtube.com/embed/")) {
    type = "youtube";
    title = "YouTube Video";
  } else if (url.includes("player.vimeo.com/video/")) {
    type = "vimeo";
    title = "Vimeo Video";
  }

  if (type) {
    chrome.runtime.sendMessage({
      action: "register_detected_video",
      video: {
        url: url,
        type: type,
        quality: "DOM",
        resolution: type === "hls" || type === "dash" ? "Auto" : "Direct",
        title: title,
        source: source
      }
    }).catch((err) => {
      // Suppress connection errors if background is reloading
    });
  }
}

// 1. Initial scan on load
if (document.readyState === "complete" || document.readyState === "interactive") {
  scanPageForVideos();
} else {
  document.addEventListener("DOMContentLoaded", scanPageForVideos);
}

// 2. Watch for dynamic DOM additions (crucial for Single Page Applications/SPAs)
const pageObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      if (node.tagName === "VIDEO") {
        handleVideoElement(node);
      } else {
        const childVideos = node.querySelectorAll("video");
        childVideos.forEach((video) => handleVideoElement(video));
        
        const childSources = node.querySelectorAll("source");
        childSources.forEach((source) => {
          if (source.src) reportVideo(source.src, "source_dynamic");
        });
      }
    });
  });
});

pageObserver.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true
});

// Responds to duration query from popup to calculate quality file size estimates
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get_video_duration") {
    const video = document.querySelector("video");
    sendResponse({ duration: video ? video.duration : 0 });
  }
  return true;
});
