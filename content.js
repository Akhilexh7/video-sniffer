// content.js
console.log("[Detector] Content script injected on page:", window.location.href);

// Clear the video registry in background script for this tab when page reloads/refreshes
chrome.runtime.sendMessage({ action: "clear_video_registry" }).catch(() => {});

const MEDIA_URL_PATTERN = /\.(m3u8|mpd|mp4|webm|mkv|flv|avi|mov|3gp)(?:[?#][^\s"'<>]*)?$/i;
const ABSOLUTE_MEDIA_URL_REGEX = /(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|mkv|flv|avi|mov|3gp)(?:[?#][^\s"'<>\\]*)?/gi;
const RELATIVE_MEDIA_URL_REGEX = /(?:\/|\.\.?\/)[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4|webm|mkv|flv|avi|mov|3gp)(?:[?#][^\s"'<>\\]*)?/gi;
const observedVideoElements = new WeakSet();

// Scan the page for video elements and sources
function scanPageForVideos() {
  const instagramFound = scanInstagramPageForVideos();

  const videos = document.querySelectorAll("video");
  videos.forEach((video) => {
    if (isInstagramHost() && instagramFound) {
      return;
    }
    handleVideoElement(video);
  });

  // Also check if there are source tags
  const sources = document.querySelectorAll("video source");
  sources.forEach((source) => {
    if (isInstagramHost() && instagramFound) {
      return;
    }
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

  scanAttributesForMediaUrls(document);
  scanPageMarkupForMediaUrls();
}

function handleVideoElement(video) {
  if (observedVideoElements.has(video)) return;

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
    reportVideoFromElement(video, "video", video.poster);
  }

  observedVideoElements.add(video);

  // Monitor for changes in the src attribute of this video element
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === "src" && video.src) {
        // Re-evaluate filters on dynamic src load
        if (video.loop && video.muted && !video.controls) return;
        if (video.offsetWidth > 0 && video.offsetWidth < 200) return;
        
        reportVideoFromElement(video, "video_changed", video.poster);
      }
    });
  });
  observer.observe(video, { attributes: true, attributeFilter: ["src"] });
}

function reportVideoFromElement(video, source, thumbnail) {
  const trackHints = getMediaTrackHints(video);
  reportVideo(video.src, source, thumbnail, trackHints);
}

// Reports the video to background.js
function reportVideo(url, source, thumbnail, trackHints = {}, mediaExtras = {}) {
  if (!url) return;
  
  // Ignore Blob URLs since background.js catches their underlying network requests (HLS/DASH/MP4)
  if (url.startsWith("blob:")) return;

  // Ignore DOM/markup scans on YouTube host to let native main-world sniffer register formats
  if (window.location.hostname.includes("youtube.com")) return;

  const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
  let type = null;
  let title = "";

  if (cleanUrl.includes("cdninstagram.com") && (url.includes("bytestart=") || url.includes("byteend="))) {
    type = "mp4";
    title = "Instagram Video";
  }

  if (!type && cleanUrl.includes(".m3u8")) {
    type = "hls";
    title = "HLS Video (Multi-Quality)";
  } else if (!type && cleanUrl.includes(".mpd")) {
    type = "dash";
    title = "DASH Video (Adaptive Quality)";
  } else if (!type && cleanUrl.endsWith(".mp4")) {
    type = "mp4";
    title = "MP4 Video";
  } else if (!type && cleanUrl.endsWith(".webm")) {
    type = "webm";
    title = "WebM Video";
  } else if (!type && cleanUrl.endsWith(".mkv")) {
    type = "mkv";
    title = "MKV Video";
  } else if (!type && cleanUrl.endsWith(".flv")) {
    type = "flv";
    title = "FLV Video";
  } else if (!type && cleanUrl.endsWith(".avi")) {
    type = "avi";
    title = "AVI Video";
  } else if (!type && cleanUrl.endsWith(".mov")) {
    type = "mov";
    title = "MOV Video";
  } else if (!type && cleanUrl.endsWith(".3gp")) {
    type = "3gp";
    title = "3GP Video";
  } else if (!type && url.includes("youtube.com/embed/")) {
    type = "youtube";
    title = "YouTube Video";
  } else if (!type && url.includes("player.vimeo.com/video/")) {
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
        thumbnail: thumbnail || null,
        audioUrl: mediaExtras.audioUrl || undefined,
        hasAudio: typeof trackHints.hasAudio === "boolean" ? trackHints.hasAudio : undefined,
        hasVideo: typeof trackHints.hasVideo === "boolean" ? trackHints.hasVideo : undefined
      }
    }).catch((err) => {
      // Suppress connection errors if background is reloading
    });
  }
}

function getMediaTrackHints(video) {
  let hasAudio;
  let hasVideo;

  try {
    if (video.videoWidth || video.videoHeight) {
      hasVideo = true;
    }

    if (video.audioTracks && typeof video.audioTracks.length === "number") {
      hasAudio = video.audioTracks.length > 0;
    } else if (typeof video.webkitAudioDecodedByteCount === "number") {
      hasAudio = video.webkitAudioDecodedByteCount > 0;
    }
  } catch (e) {}

  return { hasAudio, hasVideo };
}

function reportMediaCandidate(candidate, source, thumbnail) {
  const resolvedUrl = normalizeCandidateUrl(candidate);
  if (!resolvedUrl || !isSupportedMediaUrl(resolvedUrl)) return;
  reportVideo(resolvedUrl, source, thumbnail);
}

function getInstagramEmbedUrl() {
  const href = window.location.href;
  let match = href.match(/\/p\/([^/?#]+)/);
  if (!match) match = href.match(/\/reel\/([^/?#]+)/);
  if (!match) match = href.match(/\/tv\/([^/?#]+)/);
  if (!match) match = href.match(/\/reels\/([^/?#]+)/);
  
  if (match && match[1]) {
    const shortcode = match[1];
    return `https://www.instagram.com/p/${shortcode}/embed/`;
  }
  return null;
}

function scanInstagramPageForVideos() {
  if (!isInstagramHost()) return false;

  const extracted = extractInstagramMediaUrls(document.documentElement ? document.documentElement.innerHTML : "");
  const urls = new Set(extracted.videoUrls);
  const audioUrl = extracted.audioUrls[0] || null;

  Array.from(document.scripts || []).forEach((script) => {
    if (script && script.textContent) {
      const scriptExtracted = extractInstagramMediaUrls(script.textContent);
      scriptExtracted.videoUrls.forEach((url) => urls.add(url));
    }
  });

  [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]'
  ].forEach((selector) => {
    const meta = document.querySelector(selector);
    if (meta && meta.content) {
      const normalized = normalizeCandidateUrl(meta.content);
      if (normalized) urls.add(normalized);
    }
  });

  // Fetch the progressive MP4 URL from the Instagram embed page
  const embedUrl = getInstagramEmbedUrl();
  if (embedUrl) {
    console.log("[Detector] Found Instagram post/reel, fetching embed payload:", embedUrl);
    fetch(embedUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((html) => {
        const embedExtracted = extractInstagramMediaUrls(html);
        console.log("[Detector] Extracted from Instagram embed HTML:", embedExtracted);
        
        const embedVideoUrls = new Set(embedExtracted.videoUrls);
        if (embedVideoUrls.size > 0) {
          embedVideoUrls.forEach((videoUrl) => {
            console.log("[Detector] Registering high-quality Instagram progressive MP4 with audio:", videoUrl);
            reportVideo(videoUrl, "instagram_embed_url", null, { hasAudio: true, hasVideo: true });
          });
        }
      })
      .catch((err) => {
        console.error("[Detector] Failed to extract from Instagram embed page:", err);
      });
    return true; // We are handling it via embed fetch
  }

  if (urls.size === 0) return false;

  Array.from(urls).forEach((url) => {
    reportVideo(url, "instagram_video_url", null, {}, audioUrl ? { audioUrl } : {});
  });

  return true;
}

function extractInstagramMediaUrls(text) {
  const videoUrls = new Set();
  const audioUrls = new Set();
  const sourceText = String(text || "");
  const videoRegex = /["'](?:video_url|og:video|og:video:secure_url|video_url_hd|video_versions)["']\s*:\s*(?:\[\s*)?["']([^"']+)['"]/gi;
  const audioRegex = /["'](?:audio_url|audio_url_hd|audio_versions)["']\s*:\s*(?:\[\s*)?["']([^"']+)['"]/gi;

  let match;
  while ((match = videoRegex.exec(sourceText)) !== null) {
    const value = match[1]
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const normalized = normalizeCandidateUrl(value);
    if (normalized) videoUrls.add(normalized);
  }

  while ((match = audioRegex.exec(sourceText)) !== null) {
    const value = match[1]
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const normalized = normalizeCandidateUrl(value);
    if (normalized) audioUrls.add(normalized);
  }

  // Support direct video/source tags in the html text (for embeds)
  const videoTagRegex = /<video[^>]+src=["']([^"']+)["']/gi;
  const sourceTagRegex = /<source[^>]+src=["']([^"']+)["']/gi;
  while ((match = videoTagRegex.exec(sourceText)) !== null) {
    const value = match[1]
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const normalized = normalizeCandidateUrl(value);
    if (normalized) videoUrls.add(normalized);
  }
  while ((match = sourceTagRegex.exec(sourceText)) !== null) {
    const value = match[1]
      .replace(/\\u0026/gi, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&");
    const normalized = normalizeCandidateUrl(value);
    if (normalized) videoUrls.add(normalized);
  }

  return { videoUrls: Array.from(videoUrls), audioUrls: Array.from(audioUrls) };
}

function isInstagramHost() {
  return window.location.hostname.includes("instagram.com");
}

function isSupportedMediaUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.hostname.includes("cdninstagram.com") && (parsed.searchParams.has("bytestart") || parsed.searchParams.has("byteend"))) {
      return true;
    }
    return MEDIA_URL_PATTERN.test(`${parsed.pathname}${parsed.search}`);
  } catch (e) {
    return MEDIA_URL_PATTERN.test(url.split("#")[0]) || /cdninstagram\.com/i.test(url);
  }
}

function normalizeCandidateUrl(candidate) {
  if (!candidate) return null;

  let value = String(candidate)
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\&/g, "&")
    .trim();

  value = value.replace(/[),.;\]}]+$/g, "");

  try {
    return new URL(value, window.location.href).href;
  } catch (e) {
    return null;
  }
}

function scanAttributesForMediaUrls(root) {
  const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
  elements.forEach((element) => {
    Array.from(element.attributes || []).forEach((attr) => {
      if (!attr.value || !mightContainMediaUrl(attr.value)) return;
      extractMediaUrls(attr.value).forEach((url) => {
        reportMediaCandidate(url, `attribute:${attr.name}`, element.poster || null);
      });
    });
  });
}

function scanPageMarkupForMediaUrls() {
  const root = document.documentElement;
  if (!root) return;

  const markup = root.innerHTML || "";
  if (!mightContainMediaUrl(markup)) return;

  extractMediaUrls(markup).forEach((url) => {
    reportMediaCandidate(url, "page_markup");
  });
}

function extractMediaUrls(text) {
  const normalizedText = String(text)
    .replace(/\\u0026/gi, "&")
    .replace(/&amp;/gi, "&")
    .replace(/\\\//g, "/");
  const matches = new Set();

  for (const match of normalizedText.matchAll(ABSOLUTE_MEDIA_URL_REGEX)) {
    matches.add(match[0]);
  }

  for (const match of normalizedText.matchAll(RELATIVE_MEDIA_URL_REGEX)) {
    matches.add(match[0]);
  }

  return Array.from(matches);
}

function mightContainMediaUrl(text) {
  return /\.(m3u8|mpd|mp4|webm|mkv|flv|avi|mov|3gp)/i.test(String(text));
}

function debounce(fn, delay) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

function injectEarlyMediaSnifferScript() {
  const scriptStr = `
    (function() {
      if (window.__xdownloader_media_sniffer_injected__) return;
      window.__xdownloader_media_sniffer_injected__ = true;

      const mediaUrlPattern = /\\.(m3u8|mpd|mp4|webm|mkv|flv|avi|mov|3gp)(?:[?#]|$)/i;

      function maybePostUrl(value, source) {
        if (!value) return;
        let url = "";

        try {
          if (typeof value === "string") {
            url = value;
          } else if (value instanceof Request) {
            url = value.url;
          } else if (value instanceof URL) {
            url = value.href;
          } else if (value && typeof value.url === "string") {
            url = value.url;
          }
        } catch (e) {}

        if (url && mediaUrlPattern.test(url)) {
          window.postMessage({
            type: "EARLY_MEDIA_URL",
            url: url,
            source: source,
            title: document.title
          }, "*");
        }
      }

      const originalFetch = window.fetch;
      if (typeof originalFetch === "function") {
        window.fetch = function(...args) {
          maybePostUrl(args[0], "fetch");
          return originalFetch.apply(this, args).then((response) => {
            maybePostUrl(response && response.url, "fetch_response");
            return response;
          });
        };
      }

      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__xdownloader_url = url;
        maybePostUrl(url, "xhr");
        return originalOpen.apply(this, arguments);
      };

      const originalSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        if (typeof value === "string" && /^(src|href|data-src|data-hls|data-m3u8|data-url|poster)$/i.test(name)) {
          maybePostUrl(value, "setAttribute:" + name);
        }
        return originalSetAttribute.apply(this, arguments);
      };

      if (window.PerformanceObserver) {
        try {
          const observer = new PerformanceObserver((list) => {
            list.getEntries().forEach((entry) => maybePostUrl(entry.name, "performance"));
          });
          observer.observe({ entryTypes: ["resource"] });
        } catch (e) {}
      }

      try {
        performance.getEntriesByType("resource").forEach((entry) => maybePostUrl(entry.name, "performance_existing"));
      } catch (e) {}
    })();
  `;

  const script = document.createElement("script");
  script.textContent = scriptStr;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

injectEarlyMediaSnifferScript();

// 1. Initial scan on load
if (document.readyState === "complete" || document.readyState === "interactive") {
  scanPageForVideos();
} else {
  document.addEventListener("DOMContentLoaded", scanPageForVideos);
}

// 2. Watch for dynamic DOM additions (crucial for Single Page Applications/SPAs)
const scheduleDeepScan = debounce(() => {
  scanAttributesForMediaUrls(document);
  scanPageMarkupForMediaUrls();
}, 700);

const pageObserver = new MutationObserver((mutations) => {
  let shouldDeepScan = false;

  mutations.forEach((mutation) => {
    if (mutation.type === "attributes") {
      const element = mutation.target;
      const value = element.getAttribute(mutation.attributeName);
      if (value && mightContainMediaUrl(value)) {
        extractMediaUrls(value).forEach((url) => {
          reportMediaCandidate(url, `attribute_changed:${mutation.attributeName}`, element.poster || null);
        });
      }
      return;
    }

    mutation.addedNodes.forEach((node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      shouldDeepScan = true;

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

      scanAttributesForMediaUrls(node);
      if (node.textContent && mightContainMediaUrl(node.textContent)) {
        extractMediaUrls(node.textContent).forEach((url) => {
          reportMediaCandidate(url, "dynamic_markup");
        });
      }
    });
  });

  if (shouldDeepScan) scheduleDeepScan();
});

pageObserver.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "data-src", "data-hls", "data-m3u8", "data-url", "poster"]
});

// Responds to duration query from popup to calculate quality file size estimates
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get_video_duration") {
    const video = document.querySelector("video");
    sendResponse({ duration: video ? video.duration : 0 });
  } else if (message.action === "get_video_preview") {
    const video = findMatchingVideo(message.url) || getPrimaryVideo();
    sendResponse({ preview: getVideoPreview(video) });
  }
  return true;
});

function findMatchingVideo(url) {
  if (!url) return null;

  const cleanTarget = cleanMediaUrl(url);
  const videos = Array.from(document.querySelectorAll("video"));
  return videos.find((video) => {
    if (video.src && cleanMediaUrl(video.src) === cleanTarget) return true;

    return Array.from(video.querySelectorAll("source")).some((source) => {
      return source.src && cleanMediaUrl(source.src) === cleanTarget;
    });
  }) || null;
}

function getPrimaryVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  return videos.find((video) => video.offsetWidth >= 200 && video.offsetHeight >= 120) || videos[0] || null;
}

function getVideoPreview(video) {
  if (!video) return findPageImagePreview();

  const posterPreview = normalizePreviewImageUrl(video.poster);
  if (posterPreview) return posterPreview;

  try {
    if (video.videoWidth && video.videoHeight) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * canvas.width));

      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.72);
    }
  } catch (e) {
    console.warn("[Detector] Unable to capture video preview frame:", e);
  }

  return findNearbyImagePreview(video) || findPageImagePreview();
}

function findNearbyImagePreview(video) {
  const containers = [
    video.closest("article"),
    video.closest('[role="dialog"]'),
    video.closest("main"),
    video.parentElement
  ].filter(Boolean);

  for (const container of containers) {
    const preview = findBestImageInContainer(container, video);
    if (preview) return preview;
  }

  return null;
}

function findPageImagePreview() {
  const metaPreview = getMetaPreviewImage();
  if (metaPreview) return metaPreview;

  return findBestImageInContainer(document);
}

function getMetaPreviewImage() {
  const selectors = [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]'
  ];

  for (const selector of selectors) {
    const meta = document.querySelector(selector);
    const preview = normalizePreviewImageUrl(meta && meta.content);
    if (preview) return preview;
  }

  return null;
}

function findBestImageInContainer(container, video) {
  const images = Array.from(container.querySelectorAll("img"));
  let best = null;
  let bestScore = 0;
  const videoRect = video ? video.getBoundingClientRect() : null;

  images.forEach((img) => {
    const src = normalizePreviewImageUrl(img.currentSrc || img.src);
    if (!src) return;

    const rect = img.getBoundingClientRect();
    const width = rect.width || img.naturalWidth || 0;
    const height = rect.height || img.naturalHeight || 0;
    if (width < 80 || height < 80) return;

    const area = width * height;
    let score = area;

    if (videoRect && rect.width && rect.height) {
      const centerDistance = Math.hypot(
        (rect.left + rect.width / 2) - (videoRect.left + videoRect.width / 2),
        (rect.top + rect.height / 2) - (videoRect.top + videoRect.height / 2)
      );
      score -= centerDistance * 25;
    }

    if (img.alt && /profile picture|avatar/i.test(img.alt)) {
      score -= area * 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = src;
    }
  });

  return best;
}

function normalizePreviewImageUrl(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!value || value.startsWith("blob:")) return null;
  if (value.startsWith("data:image/")) return value;

  try {
    const parsed = new URL(value, window.location.href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
}

function cleanMediaUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (e) {
    return url.split("#")[0];
  }
}

// --- YouTube Sniffer Logic ---
// YouTube sniffer is executed via youtube-main.js in the MAIN world, configured in manifest.json.

function handleYouTubeResponse(response, pageTitle) {
  console.log("[YouTube Content] handleYouTubeResponse called. Page title:", pageTitle);
  const streamingData = response.streamingData;
  if (!streamingData) {
    console.log("[YouTube Content] No streamingData found in player response.");
    return;
  }

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

  const title = (response.videoDetails && response.videoDetails.title) ? response.videoDetails.title : pageTitle;
  const videoId = (response.videoDetails && response.videoDetails.videoId) ? response.videoDetails.videoId : null;

  const formats = [];
  if (streamingData.formats) {
    streamingData.formats.forEach(f => {
      f.isProgressive = true;
      formats.push(f);
    });
  }
  if (streamingData.adaptiveFormats) {
    streamingData.adaptiveFormats.forEach(f => {
      f.isProgressive = false;
      formats.push(f);
    });
  }

  console.log(`[YouTube Content] Found ${formats.length} formats total.`);

  let directCount = 0;
  let sentCount = 0;

  formats.forEach((format) => {
    // Log for Bug #3
    console.log(
      "itag",
      format.itag,
      "url?",
      !!format.url,
      "cipher?",
      !!format.signatureCipher,
      "cipher2?",
      !!format.cipher
    );

    if (format.url) {
      directCount++;
      const mime = format.mimeType || "";
      const isVideo = format.isProgressive || mime.startsWith("video/");
      const isAudio = format.isProgressive || mime.startsWith("audio/");
      const container = (mime.includes("webm") || mime.includes("vp9") || mime.includes("opus")) ? "webm" : "mp4";
      const resolution = format.qualityLabel || (format.bitrate ? `${Math.round(format.bitrate / 1000)}kbps` : "Audio");

      sentCount++;
      console.log(`[YouTube Content] Sending register_youtube_format for itag ${format.itag} (${resolution}, ${container})`);
      chrome.runtime.sendMessage({
        action: "register_youtube_format",
        format: {
          url: format.url,
          itag: format.itag,
          videoId: videoId,
          title: title,
          thumbnail: thumbnail,
          hasVideo: isVideo,
          hasAudio: isAudio,
          resolution: resolution,
          container: container
        }
      }).catch(() => {});
    }
  });

  console.log("StreamingData:", !!streamingData);
  console.log("Formats:", streamingData.formats?.length || 0);
  console.log("Adaptive:", streamingData.adaptiveFormats?.length || 0);
  console.log("Direct URLs:", directCount);
  console.log("Messages sent:", sentCount);
}

// Set up listeners for messages from main world
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === "YOUTUBE_PLAYER_RESPONSE") {
    handleYouTubeResponse(event.data.response, event.data.title);
  } else if (event.data && event.data.type === "EARLY_MEDIA_URL") {
    reportMediaCandidate(event.data.url, event.data.source);
  }
});

// Native sniffer script handles YOUTUBE_PLAYER_RESPONSE posting.

// Listener for proxy fetches from the extension background/offscreen contexts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "proxy_fetch") {
    const { url, options, responseType } = message;
    
    fetch(url, options)
      .then(async (response) => {
        if (!response.ok) {
          sendResponse({
            success: false,
            status: response.status,
            statusText: response.statusText,
            error: `HTTP ${response.status} ${response.statusText}`
          });
          return;
        }

        const headers = {};
        response.headers.forEach((val, key) => {
          const lKey = key.toLowerCase();
          if (["content-length", "content-range", "content-type", "accept-ranges"].includes(lKey)) {
            headers[lKey] = val;
          }
        });
        
        if (responseType === "arraybuffer") {
          const buffer = await response.arrayBuffer();
          let binary = "";
          const bytes = new Uint8Array(buffer);
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          sendResponse({
            success: true,
            status: response.status,
            headers: headers,
            data: base64,
            responseType: "base64",
            responseUrl: response.url
          });
        } else {
          const text = await response.text();
          sendResponse({
            success: true,
            status: response.status,
            headers: headers,
            data: text,
            responseType: "text",
            responseUrl: response.url
          });
        }
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message
        });
      });
      
    return true; // Keep channel open for async response
  }
});
