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
  scanPreloadAndScripts();
}

function primeVideoMetadata(video) {
  if (video.preload === "none" || !video.preload) {
    video.preload = "metadata";
  }
  if (video.readyState === 0 && video.src) {
    try {
      video.load();
    } catch (e) {}
  }
}

function handleVideoElement(video) {
  if (observedVideoElements.has(video)) return;

  primeVideoMetadata(video);

  const checkAndReport = () => {
    const isInsta = isInstagramHost();

    // Skip silent looping previews (e.g. video thumbnails on hover), except on Instagram
    if (!isInsta && video.loop && video.muted && !video.controls) {
      console.log("[Detector] Skipping muted looping preview video tag.");
      return;
    }

    // Skip tiny preview cards or ad players (width/height under 200px)
    if (video.offsetWidth > 0 && video.offsetWidth < 200) {
      console.log("[Detector] Skipping small preview thumbnail video tag.");
      return;
    }

    // Skip short previews (under 8 seconds duration), except on Instagram
    if (!isInsta && video.duration && video.duration < 8) {
      console.log("[Detector] Skipping likely preview (duration < 8s).");
      return;
    }

    if (video.src) {
      reportVideoFromElement(video, "video", video.poster);
    }
  };

  checkAndReport();

  video.addEventListener("loadedmetadata", checkAndReport);
  video.addEventListener("durationchange", checkAndReport);

  observedVideoElements.add(video);

  // Monitor for changes in the src attribute of this video element
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === "src" && video.src) {
        checkAndReport();
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
  
  let instagramDescription = null;
  if (window.location.hostname.includes("instagram.com")) {
    try {
      const ogDesc = document.querySelector('meta[property="og:description"]');
      const descMeta = document.querySelector('meta[name="description"]');
      const ogTitle = document.querySelector('meta[property="og:title"]');
      
      let rawDesc = "";
      if (ogDesc && ogDesc.content) {
        rawDesc = ogDesc.content;
      } else if (descMeta && descMeta.content) {
        rawDesc = descMeta.content;
      } else if (ogTitle && ogTitle.content) {
        rawDesc = ogTitle.content;
      }
      
      if (rawDesc) {
        const quoteMatch = rawDesc.match(/:\s*['"](.+?)['"](?:\s*|$)/s);
        if (quoteMatch && quoteMatch[1]) {
          instagramDescription = quoteMatch[1];
        } else {
          const onInstaIdx = rawDesc.indexOf("on Instagram:");
          if (onInstaIdx !== -1) {
            instagramDescription = rawDesc.substring(0, onInstaIdx).trim();
          } else {
            instagramDescription = rawDesc;
          }
        }
        
        if (instagramDescription) {
          instagramDescription = instagramDescription
            .replace(/[\\/*?:"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (instagramDescription.length > 96) {
            instagramDescription = instagramDescription.substring(0, 96).trim();
          }
        }
      }
    } catch (e) {
      console.warn("[Detector] Failed to extract Instagram description:", e);
    }
  }

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
        resolution: trackHints.resolution || (type === "hls" || type === "dash" ? "Auto" : "Direct"),
        title: title,
        source: source,
        thumbnail: thumbnail || null,
        audioUrl: mediaExtras.audioUrl || undefined,
        hasAudio: typeof trackHints.hasAudio === "boolean" ? trackHints.hasAudio : undefined,
        hasVideo: typeof trackHints.hasVideo === "boolean" ? trackHints.hasVideo : undefined,
        instagramDescription: instagramDescription || undefined
      }
    }).catch((err) => {
      // Suppress connection errors if background is reloading
    });
  }
}

function getMediaTrackHints(video) {
  let hasAudio;
  let hasVideo;
  let resolution;

  try {
    if (video.videoWidth || video.videoHeight) {
      hasVideo = true;
      resolution = `${video.videoWidth}x${video.videoHeight}`;
    }

    if (video.audioTracks && typeof video.audioTracks.length === "number") {
      hasAudio = video.audioTracks.length > 0;
    } else if (typeof video.webkitAudioDecodedByteCount === "number") {
      hasAudio = video.webkitAudioDecodedByteCount > 0;
    }
  } catch (e) {}

  return { hasAudio, hasVideo, resolution };
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
    // Keep Instagram downloads as the exact media URL exposed by the page.
    // Do not infer or attach a second audio URL for browser-side remuxing.
    reportVideo(url, "instagram_video_url", null);
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
  if (document.querySelectorAll("video").length > 0) {
    console.log("[Detector] Skipping attribute scan — standard DOM video already exists.");
    return;
  }
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
  if (document.querySelectorAll("video").length > 0) {
    console.log("[Detector] Skipping markup scan — standard DOM video already exists.");
    return;
  }
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
      if (window.__unvdownloader_media_sniffer_injected__) return;
      window.__unvdownloader_media_sniffer_injected__ = true;

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
        this.__unvdownloader_url = url;
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

      function hookPlayerLibraries() {
        if (window.videojs) {
          const originalVideojs = window.videojs;
          window.videojs = function(...args) {
            const player = originalVideojs.apply(this, args);
            try {
              const src = player.currentSrc?.() || player.src?.();
              if (src) maybePostUrl(src, "videojs_init");
            } catch (e) {}
            return player;
          };
        }

        if (window.jwplayer) {
          const originalSetup = window.jwplayer.prototype?.setup;
          if (originalSetup) {
            window.jwplayer.prototype.setup = function(config) {
              try {
                const sources = config?.sources || (config?.file ? [{ file: config.file }] : []);
                sources.forEach(s => {
                  if (s.file) maybePostUrl(s.file, "jwplayer_setup");
                });
              } catch (e) {}
              return originalSetup.apply(this, arguments);
            };
          }
        }

        if (window.Hls) {
          const originalLoadSource = window.Hls.prototype.loadSource;
          window.Hls.prototype.loadSource = function(url) {
            maybePostUrl(url, "hlsjs_loadsource");
            return originalLoadSource.apply(this, arguments);
          };
        }
      }

      let hookAttempts = 0;
      const hookInterval = setInterval(() => {
        hookPlayerLibraries();
        if (++hookAttempts > 20) clearInterval(hookInterval);
      }, 500);
    })();
  `;

  const script = document.createElement("script");
  script.textContent = scriptStr;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function scanPreloadAndScripts() {
  // 1. Scan preloads
  document.querySelectorAll('link[rel="preload"][as="video"], link[rel="preload"][as="fetch"]').forEach(link => {
    if (link.href && mightContainMediaUrl(link.href)) {
      reportMediaCandidate(link.href, "link_preload");
    }
  });

  // 2. Scan inline scripts
  Array.from(document.scripts).forEach(script => {
    if (!script.textContent || !mightContainMediaUrl(script.textContent)) return;
    
    const patterns = [
      /"?(?:file|src|source|url)"?\s*:\s*"([^"]+\.(?:m3u8|mpd|mp4|webm|mkv|flv|avi|mov|3gp)[^"]*)"/gi,
      /sources\s*:\s*\[\s*\{[^}]*?"(?:file|src)"\s*:\s*"([^"]+)"/gi
    ];
    
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(script.textContent)) !== null) {
        reportMediaCandidate(match[1], "inline_script_config");
      }
    });
  });
}

injectEarlyMediaSnifferScript();

// 1. Initial scan on load
if (document.readyState === "complete" || document.readyState === "interactive") {
  scanPageForVideos();
} else {
  document.addEventListener("DOMContentLoaded", scanPageForVideos);
}



function scanPageMarkupForMediaUrlsRaw() {
  const root = document.documentElement;
  if (!root) return;
  const markup = root.innerHTML || "";
  if (!mightContainMediaUrl(markup)) return;
  extractMediaUrls(markup).forEach((url) => {
    reportMediaCandidate(url, "page_markup_deep");
  });
}

async function runDeepScan() {
  console.log("[Detector Deep Scan] Starting manual deep scan...");
  
  // 1. Re-run standard DOM detection
  scanPageForVideos();

  // 2. Prime metadata preload for all video tags
  document.querySelectorAll("video").forEach(primeVideoMetadata);

  // 3. Perform deep markup, attributes, preload, and script configs scans
  scanAttributesForMediaUrls(document);
  scanPageMarkupForMediaUrlsRaw();
  scanPreloadAndScripts();

  // 4. Wait for background registrations to settle
  await new Promise((resolve) => setTimeout(resolve, 800));

  // 5. Query and return the final registry state
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "get_detected_videos" }, (res) => {
      resolve(res || { videos: [] });
    });
  });

  console.log("[Detector Deep Scan] Complete.");
  return { videos: response.videos || [] };
}

// Responds to queries from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get_video_duration") {
    const video = document.querySelector("video");
    sendResponse({ duration: video ? video.duration : 0 });
    return true;
  } else if (message.action === "run_deep_scan") {
    runDeepScan().then((res) => sendResponse(res));
    return true; // Keep channel open for async response
  } else if (message.action === "get_video_preview") {
    const video = findMatchingVideo(message.url) || getPrimaryVideo();
    const preview = getVideoPreview(video);
    if (preview) {
      sendResponse({ preview: preview });
    } else {
      generateFrameThumbnail(message.url)
        .then((fallback) => {
          sendResponse({ preview: fallback });
        })
        .catch(() => {
          sendResponse({ preview: null });
        });
      return true; // Keep message channel open for async response
    }
  }
  return true;
});

const frameQueue = [];
let activeFrameCaptures = 0;
const MAX_CONCURRENT_CAPTURES = 2;

function queueFrameCapture(videoUrl, seekTo) {
  return new Promise((resolve) => {
    frameQueue.push({ videoUrl, seekTo, resolve });
    processFrameQueue();
  });
}

function processFrameQueue() {
  if (activeFrameCaptures >= MAX_CONCURRENT_CAPTURES || frameQueue.length === 0) return;
  const { videoUrl, seekTo, resolve } = frameQueue.shift();
  activeFrameCaptures++;

  generateFrameThumbnailRaw(videoUrl, seekTo)
    .then((result) => {
      activeFrameCaptures--;
      resolve(result);
      processFrameQueue();
    })
    .catch(() => {
      activeFrameCaptures--;
      resolve(null);
      processFrameQueue();
    });
}

async function generateFrameThumbnail(videoUrl, seekTo = null) {
  return queueFrameCapture(videoUrl, seekTo);
}

async function generateFrameThumbnailRaw(videoUrl, seekTo = null) {
  if (!videoUrl || videoUrl.includes(".m3u8") || videoUrl.startsWith("blob:")) {
    return null;
  }

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "metadata"; // triggers only a small initial range request, not full download
    video.muted = true;
    video.playsInline = true;
    video.style.display = "none";
    document.body.appendChild(video);

    let settled = false;
    const cleanup = () => {
      video.remove();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // Give up after 3.5s so a broken/slow stream never hangs the popup
    const timeout = setTimeout(() => finish(null), 3500);

    video.addEventListener("loadedmetadata", () => {
      const target = seekTo ?? Math.min(video.duration * 0.1, 3);
      video.currentTime = isFinite(target) && target > 0 ? target : 0.1;
    });

    video.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = video.videoHeight
          ? Math.round((video.videoHeight / video.videoWidth) * 320)
          : 180;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        clearTimeout(timeout);
        finish(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        clearTimeout(timeout);
        finish(null);
      }
    });

    video.addEventListener("error", () => {
      clearTimeout(timeout);
      finish(null);
    });

    video.src = videoUrl;
  });
}

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
    const { url, options, responseType, requestId } = message;
    
    // Only proxy requests to the same origin as the page, or an allowed CDN domain
    const pageOrigin = window.location.origin;
    let requestOrigin;
    try {
      requestOrigin = new URL(url).origin;
    } catch (e) {
      if (requestId) {
        chrome.runtime.sendMessage({ action: "proxy_fetch_response", requestId, success: false, error: "Invalid URL" }).catch(() => {});
      } else {
        sendResponse({ success: false, error: "Invalid URL" });
      }
      return true;
    }

    const isSameOrigin = requestOrigin === pageOrigin;
    const isKnownCdn = /googlevideo\.com|cdninstagram\.com|phncdn\.com/.test(requestOrigin);

    if (!isSameOrigin && !isKnownCdn) {
      console.warn("[Proxy Fetch] Rejected — origin not allowlisted:", requestOrigin);
      if (requestId) {
        chrome.runtime.sendMessage({ action: "proxy_fetch_response", requestId, success: false, error: "Origin not permitted for proxy fetch" }).catch(() => {});
      } else {
        sendResponse({ success: false, error: "Origin not permitted for proxy fetch" });
      }
      return true;
    }

    if (requestId) {
      sendResponse({ success: true, pending: true });
    }

    // Instagram CDN requests need the current signed-in session and a page
    // referer.  Content-script fetches otherwise omit cross-site cookies.
    fetch(url, {
      ...options,
      credentials: "include",
      referrer: window.location.href,
      referrerPolicy: "strict-origin-when-cross-origin"
    })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 403) {
            console.error('[Download Diagnostics] HTTP 403 Forbidden on proxy fetch', {
              url: url,
              requestHeaders: options ? options.headers : null,
              responseHeaders: Object.fromEntries(response.headers.entries()),
              timestamp: new Date().toISOString()
            });
          }
          const failPayload = {
            success: false,
            status: response.status,
            statusText: response.statusText,
            error: `HTTP ${response.status} ${response.statusText}`
          };
          if (requestId) {
            chrome.runtime.sendMessage({ action: "proxy_fetch_response", requestId, ...failPayload }).catch(() => {});
          } else {
            sendResponse(failPayload);
          }
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
          const blob = new Blob([buffer]);
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result.split(',')[1];
            if (requestId) {
              chrome.runtime.sendMessage({
                action: "proxy_fetch_response",
                requestId: requestId,
                success: true,
                status: response.status,
                headers: headers,
                data: base64,
                responseType: "base64",
                responseUrl: response.url
              }).catch(() => {});
            } else {
              sendResponse({
                success: true,
                status: response.status,
                headers: headers,
                data: base64,
                responseType: "base64",
                responseUrl: response.url
              });
            }
          };
          reader.readAsDataURL(blob);
        } else {
          const text = await response.text();
          const successPayload = {
            success: true,
            status: response.status,
            headers: headers,
            data: text,
            responseType: "text",
            responseUrl: response.url
          };
          if (requestId) {
            chrome.runtime.sendMessage({ action: "proxy_fetch_response", requestId, ...successPayload }).catch(() => {});
          } else {
            sendResponse(successPayload);
          }
        }
      })
      .catch((err) => {
        const errPayload = {
          success: false,
          error: err.message
        };
        if (requestId) {
          chrome.runtime.sendMessage({ action: "proxy_fetch_response", requestId, ...errPayload }).catch(() => {});
        } else {
          sendResponse(errPayload);
        }
      });
      
    return true; // Keep channel open for async response
  }
});
