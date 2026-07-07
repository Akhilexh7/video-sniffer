// hls-parser.js

/**
 * Parses an M3U8 index file to extract resolutions and qualities.
 * @param {string} m3u8Url The URL of the manifest file
 * @returns {Promise<Array<{quality: string, url: string}>>}
 */
export async function parseM3U8(m3u8Url) {
  console.log(`[Parser] Fetching manifest: ${m3u8Url}`);
  const response = await fetch(m3u8Url);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.statusText}`);
  }
  
  const text = await response.text();
  if (!text.startsWith("#EXTM3U")) {
    throw new Error("Invalid M3U8 playlist format");
  }

  const lines = text.split("\n");
  const streams = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
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
        const fullUrl = resolveUrl(m3u8Url, urlLine);
        const quality = metadata.resolution 
          ? `${metadata.resolution.split("x")[1]}p` 
          : metadata.bandwidth 
            ? `${Math.round(metadata.bandwidth / 1000)}k` 
            : "Unknown";

        streams.push({
          quality: quality,
          url: fullUrl,
          resolution: metadata.resolution || "Auto",
          bandwidth: metadata.bandwidth || 0
        });
      }
    }
  }

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
  
  // Extract RESOLUTION=1920x1080
  const resMatch = line.match(/RESOLUTION=([0-9]+x[0-9]+)/i);
  if (resMatch) {
    result.resolution = resMatch[1];
  }

  // Extract BANDWIDTH=5000000
  const bwMatch = line.match(/BANDWIDTH=([0-9]+)/i);
  if (bwMatch) {
    result.bandwidth = parseInt(bwMatch[1]);
  }

  return result;
}

// Resolves relative URLs based on manifest base URL
function resolveUrl(baseUrl, relativeUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (e) {
    // Fallback if URL constructor fails
    if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
      return relativeUrl;
    }
    
    const baseParts = baseUrl.split("/");
    baseParts.pop(); // remove filename
    
    if (relativeUrl.startsWith("/")) {
      const domainMatch = baseUrl.match(/^(https?:\/\/[^\/]+)/);
      const domain = domainMatch ? domainMatch[1] : "";
      return domain + relativeUrl;
    }
    
    return baseParts.join("/") + "/" + relativeUrl;
  }
}
