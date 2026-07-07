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
      const parentVideo = source.closest("video");
      const thumbnail = parentVideo ? parentVideo.poster : null;
      reportVideo(source.src, "source", thumbnail);
    }
  });

  // Check iframe elements (like Vimeo/YouTube embeds)
  const iframes = document.querySelectorAll("iframe");
  iframes.forEach((iframe) => {
    if (iframe.src && (iframe.src.includes("youtube.com/embed/") || iframe.src.includes("player.vimeo.com/video/"))) {
      let thumbnail = null;
      if (iframe.src.includes("youtube.com/embed/")) {
        try {
          const match = iframe.src.match(/\/embed\/([^/?#]+)/);
          if (match && match[1]) {
            thumbnail = `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`;
          }
        } catch (e) {}
      }
      reportVideo(iframe.src, "iframe", thumbnail);
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
    reportVideo(video.src, "video", video.poster);
  }

  // Monitor for changes in the src attribute of this video element
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === "src" && video.src) {
        // Re-evaluate filters on dynamic src load
        if (video.loop && video.muted && !video.controls) return;
        if (video.offsetWidth > 0 && video.offsetWidth < 200) return;
        
        reportVideo(video.src, "video_changed", video.poster);
      }
    });
  });
  observer.observe(video, { attributes: true, attributeFilter: ["src"] });
}

// Reports the video to background.js
function reportVideo(url, source, thumbnail) {
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
        source: source,
        thumbnail: thumbnail || null
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

// --- YouTube Sniffer Logic ---
function injectMainWorldScript() {
  const scriptStr = `
    (function() {
      if (window.__youtube_sniffer_injected__) return;
      window.__youtube_sniffer_injected__ = true;

      console.log("[YouTube Sniffer] Main world script injected.");

      function checkAndPostPlayerResponse() {
        const player = document.getElementById("movie_player");
        if (player && typeof player.getPlayerResponse === "function") {
          const response = player.getPlayerResponse();
          if (response) {
            window.postMessage({
              type: "YOUTUBE_PLAYER_RESPONSE",
              response: response,
              title: document.title
            }, "*");
          }
        } else if (window.ytInitialPlayerResponse) {
          window.postMessage({
            type: "YOUTUBE_PLAYER_RESPONSE",
            response: window.ytInitialPlayerResponse,
            title: document.title
          }, "*");
        }
      }

      // Check immediately
      checkAndPostPlayerResponse();

      // Check on player state changes or page navigations
      document.addEventListener("yt-navigate-finish", () => {
        setTimeout(checkAndPostPlayerResponse, 500);
      });
      document.addEventListener("yt-page-data-updated", () => {
        setTimeout(checkAndPostPlayerResponse, 500);
      });

      // Intercept dynamic XHR/fetch player responses
      const originalFetch = window.fetch;
      window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0];
        if (typeof url === 'string' && url.includes('/youtubei/v1/player')) {
          try {
            const clone = response.clone();
            const json = await clone.json();
            window.postMessage({ type: 'YOUTUBE_PLAYER_RESPONSE', response: json, title: document.title }, '*');
          } catch (e) {}
        }
        return response;
      };

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
          if (this._url && this._url.includes('/youtubei/v1/player')) {
            try {
              const json = JSON.parse(this.responseText);
              window.postMessage({ type: 'YOUTUBE_PLAYER_RESPONSE', response: json, title: document.title }, '*');
            } catch (e) {}
          }
        });
        return originalSend.apply(this, arguments);
      };

      // Periodic fallback check (e.g. for SPA transition edge cases)
      let lastUrl = window.location.href;
      setInterval(() => {
        if (window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          setTimeout(checkAndPostPlayerResponse, 1000);
        }
      }, 1000);
    })();
  `;

  const script = document.createElement("script");
  script.textContent = scriptStr;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function handleYouTubeResponse(response, pageTitle) {
  const streamingData = response.streamingData;
  if (!streamingData) return;

  // Extract thumbnail
  let thumbnail = null;
  if (response.videoDetails && response.videoDetails.thumbnail && response.videoDetails.thumbnail.thumbnails) {
    const thumbs = response.videoDetails.thumbnail.thumbnails;
    if (thumbs.length > 0) {
      thumbnail = thumbs[thumbs.length - 1].url;
    }
  }
  if (!thumbnail && response.videoDetails && response.videoDetails.videoId) {
    thumbnail = `https://img.youtube.com/vi/${response.videoDetails.videoId}/mqdefault.jpg`;
  }

  const formats = [];
  if (streamingData.formats) {
    formats.push(...streamingData.formats);
  }
  if (streamingData.adaptiveFormats) {
    formats.push(...streamingData.adaptiveFormats);
  }

  formats.forEach((format) => {
    // Only report direct URLs (no signatureCipher here, those are handled via network interception in background.js)
    if (format.url) {
      chrome.runtime.sendMessage({
        action: "register_detected_video",
        video: {
          url: format.url,
          type: "youtube_stream",
          quality: "YouTube",
          resolution: "Detect",
          title: "YouTube Video",
          pageTitle: pageTitle,
          itag: format.itag,
          thumbnail: thumbnail
        }
      }).catch(() => {});
    }
  });
}

// Set up listeners for messages from main world
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === "YOUTUBE_PLAYER_RESPONSE") {
    handleYouTubeResponse(event.data.response, event.data.title);
  }
});

// Run YouTube sniffer if on YouTube
if (window.location.hostname.includes("youtube.com")) {
  injectMainWorldScript();
}
