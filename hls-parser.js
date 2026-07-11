// hls-parser.js

/**
 * Parses an M3U8 index file to extract resolutions and qualities.
 * @param {string} m3u8Url The URL of the manifest file
 * @returns {Promise<Array<{quality: string, url: string}>>}
 */
async function fetchText(url, tabId, frameId = null) {
  if (tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: "background_proxy_fetch",
          tabId: tabId,
          frameId: frameId,
          url: url,
          responseType: "text"
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve({ text: response.data, finalUrl: response.responseUrl || url });
          } else {
            reject(new Error(response ? response.error : "Failed proxy fetch"));
          }
        });
      });
    } catch (e) {
      console.warn(`[Parser] Proxy fetch failed for tab ${tabId}. Falling back to direct fetch.`, e);
    }
  }
  
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return { text, finalUrl: response.url || url };
}

export async function parseM3U8(m3u8Url, tabId = null, frameId = null) {
  console.log(`[Parser] Fetching manifest: ${m3u8Url} for tab: ${tabId}`);
  const res = await fetchText(m3u8Url, tabId, frameId);
  const text = res.text;
  const finalUrl = res.finalUrl;
  
  if (!text.startsWith("#EXTM3U")) {
    throw new Error("Invalid M3U8 playlist format");
  }

  const lines = text.split("\n");
  const streams = [];
  const audioGroups = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const media = parseAttributeList(line.substring("#EXT-X-MEDIA:".length));
      if (media.TYPE === "AUDIO" && media["GROUP-ID"] && media.URI) {
        const groupId = media["GROUP-ID"];
        if (!audioGroups[groupId]) audioGroups[groupId] = [];
        audioGroups[groupId].push({
          groupId,
          name: media.NAME || "Audio",
          language: media.LANGUAGE || "",
          default: media.DEFAULT === "YES",
          autoselect: media.AUTOSELECT === "YES",
          url: resolveUrl(finalUrl, media.URI)
        });
      }
      continue;
    }
    
    // Check for Master Playlist Stream Info
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const metadata = parseStreamInf(line);
      
      // The actual stream playlist URL resides on the next non-empty line
      let urlLine = "";
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith("#")) {
          urlLine = nextLine;
          i = j; // Move outer loop index forward
          break;
        }
      }

      if (urlLine) {
        const fullUrl = resolveUrl(finalUrl, urlLine);
        const quality = metadata.resolution 
          ? `${metadata.resolution.split("x")[1]}p` 
          : metadata.bandwidth 
            ? `${Math.round(metadata.bandwidth / 1000)}k` 
            : "Unknown";

        streams.push({
          quality: quality,
          url: fullUrl,
          resolution: metadata.resolution || "Auto",
          bandwidth: metadata.bandwidth || 0,
          audioGroupId: metadata.audioGroupId || null
        });
      }
    }
  }

  streams.forEach((stream) => {
    const renditions = stream.audioGroupId ? (audioGroups[stream.audioGroupId] || []) : [];
    stream.audioRenditions = renditions;
    stream.audioUrl = selectDefaultAudioRendition(renditions)?.url || null;
  });

  // Sort streams by resolution/bandwidth descending (highest quality first)
  streams.sort((a, b) => {
    if (a.bandwidth && b.bandwidth) return b.bandwidth - a.bandwidth;
    const resA = parseInt(a.quality) || 0;
    const resB = parseInt(b.quality) || 0;
    return resB - resA;
  });

  console.log(`[Parser] Qualities extracted:`, streams);
  return streams;
}

// Parses attributes of #EXT-X-STREAM-INF
function parseStreamInf(line) {
  const result = {};
  const attributes = parseAttributeList(line.substring("#EXT-X-STREAM-INF:".length));
  
  // Extract RESOLUTION=1920x1080
  if (attributes.RESOLUTION) {
    result.resolution = attributes.RESOLUTION;
  }

  // Extract BANDWIDTH=5000000
  if (attributes.BANDWIDTH) {
    result.bandwidth = parseInt(attributes.BANDWIDTH);
  }

  if (attributes.AUDIO) {
    result.audioGroupId = attributes.AUDIO;
  }

  return result;
}

function parseAttributeList(text) {
  const attributes = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const rawValue = match[2].trim();
    attributes[match[1].toUpperCase()] = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  }

  return attributes;
}

function selectDefaultAudioRendition(renditions) {
  return renditions.find((rendition) => rendition.default) || renditions[0] || null;
}

function resolveUrl(baseUrl, relativeUrl) {
  if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
    return relativeUrl;
  }
  try {
    const baseObj = new URL(baseUrl);
    const resolvedObj = new URL(relativeUrl, baseUrl);
    
    if (baseObj.search) {
      const baseParams = new URLSearchParams(baseObj.search);
      const resolvedParams = new URLSearchParams(resolvedObj.search);
      for (const [key, val] of baseParams.entries()) {
        if (!resolvedParams.has(key)) {
          resolvedParams.set(key, val);
        }
      }
      resolvedObj.search = resolvedParams.toString();
    }
    return resolvedObj.href;
  } catch (e) {
    const baseParts = baseUrl.split("/");
    baseParts.pop(); // remove filename
    
    let urlWithParams = relativeUrl;
    if (!relativeUrl.includes("?")) {
      const baseQueryIndex = baseUrl.indexOf("?");
      if (baseQueryIndex !== -1) {
        urlWithParams += baseUrl.substring(baseQueryIndex);
      }
    }
    
    if (relativeUrl.startsWith("/")) {
      const domainMatch = baseUrl.match(/^(https?:\/\/[^\/]+)/);
      const domain = domainMatch ? domainMatch[1] : "";
      return domain + urlWithParams;
    }
    
    return baseParts.join("/") + "/" + urlWithParams;
  }
}
