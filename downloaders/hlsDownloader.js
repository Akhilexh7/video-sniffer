// downloaders/hlsDownloader.js
import { remuxFragmentedMp4 } from '../mux/mp4-muxer.js';

export class HlsDownloader {
  constructor(m3u8Url, onProgress, audioM3u8Url = null, tabId = null, frameId = null) {
    this.m3u8Url = m3u8Url;
    this.audioM3u8Url = audioM3u8Url;
    this.onProgress = onProgress || (() => {});
    this.tabId = tabId;
    this.frameId = frameId;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.progress = 0;
    this.totalSegments = 0;
    this.downloadedSegments = 0;
    this.downloadedBytes = 0;
  }

  async fetchText(url) {
    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
            frameId: this.frameId,
            url: url,
            responseType: "text",
            options: {
              signal: this.abortController.signal,
              credentials: 'include'
            }
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
        console.warn(`[Downloader] Proxy fetch failed for text. Falling back to direct fetch.`, e);
      }
    }
    
    const response = await fetch(url, { signal: this.abortController.signal, credentials: 'include' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    return { text, finalUrl: response.url || url };
  }

  async fetchArrayBuffer(url, range = null) {
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
    
    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
            frameId: this.frameId,
            url: url,
            responseType: "arraybuffer",
            options: {
              signal: this.abortController.signal,
              headers: headers,
              credentials: 'include'
            }
          }, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.success) {
              const binaryString = atob(response.data);
              const len = binaryString.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              resolve(bytes.buffer);
            } else {
              reject(new Error(response ? response.error : "Failed proxy fetch"));
            }
          });
        });
      } catch (e) {
        console.warn(`[Downloader] Proxy fetch failed for segment. Falling back to direct fetch.`, e);
      }
    }
    
    const res = await fetch(url, { signal: this.abortController.signal, headers, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (range && res.status !== 206) {
      throw new Error(`HTTP ${res.status}: server did not return requested byte range`);
    }
    return await res.arrayBuffer();
  }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    console.log("[Downloader] Download cancelled by user.");
  }

  getProgress() {
    return this.progress;
  }

  async start() {
    const videoTrack = await this.loadPlaylistInfo(this.m3u8Url, "video");
    const audioTrack = this.audioM3u8Url
      ? await this.loadPlaylistInfo(this.audioM3u8Url, "audio")
      : null;

    this.totalSegments = videoTrack.segments.length + (audioTrack ? audioTrack.segments.length : 0);
    this.downloadedSegments = 0;
    this.progress = 0;

    console.log(`[Downloader] Found ${videoTrack.segments.length} video segments${audioTrack ? ` and ${audioTrack.segments.length} audio segments` : ""} to fetch.`);

    if (this.totalSegments === 0 || videoTrack.segments.length === 0) {
      throw new Error("No video segments detected in playlist.");
    }

    const downloadedVideoTrack = await this.downloadPlaylistTrack(videoTrack);
    const downloadedAudioTrack = audioTrack ? await this.downloadPlaylistTrack(audioTrack) : null;

    if (this.cancelled) {
      throw new Error("Download aborted.");
    }

    console.log("[Downloader] All segments downloaded and decrypted. Merging streams...");

    if (downloadedAudioTrack) {
      if (downloadedVideoTrack.initSegmentBuffer && downloadedAudioTrack.initSegmentBuffer) {
        console.log("[Downloader] Separate audio and video fragmented MP4 tracks detected. Muxing tracks...");
        const mergedBlob = remuxFragmentedMp4(
          downloadedVideoTrack.initSegmentBuffer,
          downloadedAudioTrack.initSegmentBuffer,
          downloadedVideoTrack.buffers,
          downloadedAudioTrack.buffers
        );
        return {
          blob: mergedBlob,
          extension: "mp4",
          mimeType: "video/mp4"
        };
      }

      if (downloadedVideoTrack.initSegmentBuffer || downloadedAudioTrack.initSegmentBuffer) {
        throw new Error("Missing audio or video initialization segment for fragmented MP4 streams.");
      }

      if (
        this.isLikelyTransportStream(downloadedVideoTrack.buffers[0]) &&
        (this.isLikelyTransportStream(downloadedAudioTrack.buffers[0]) || this.isLikelyAac(downloadedAudioTrack.buffers[0]))
      ) {
        const mp4Buffers = this.transmuxTransportStream(downloadedVideoTrack, downloadedAudioTrack);
        return {
          blob: new Blob(mp4Buffers, { type: "video/mp4" }),
          extension: "mp4",
          mimeType: "video/mp4"
        };
      }

      throw new Error("Unsupported separate audio/video HLS segment format.");
    }

    if (downloadedVideoTrack.initSegmentBuffer) {
      const finalBuffers = [downloadedVideoTrack.initSegmentBuffer, ...downloadedVideoTrack.buffers];
      return {
        blob: new Blob(finalBuffers, { type: "video/mp4" }),
        extension: "mp4",
        mimeType: "video/mp4"
      };
    }

    if (this.isLikelyTransportStream(downloadedVideoTrack.buffers[0])) {
      const mp4Buffers = this.transmuxTransportStream(downloadedVideoTrack);
      return {
        blob: new Blob(mp4Buffers, { type: "video/mp4" }),
        extension: "mp4",
        mimeType: "video/mp4"
      };
    }

    throw new Error("Unsupported HLS segment format. This playlist is not fMP4 or MPEG-TS.");
  }

  async loadPlaylistInfo(url, label) {
    console.log(`[Downloader] Loading ${label} media playlist from: ${url}`);

    let text, finalUrl;
    try {
      const res = await this.fetchText(url);
      text = res.text;
      finalUrl = res.finalUrl;
    } catch (err) {
      throw new Error(`Failed to load ${label} media playlist: ${err.message}`);
    }
    const segments = this.parseSegments(text, finalUrl);

    return {
      label,
      url,
      finalUrl,
      segments,
      initSegmentUrl: this.parseInitSegmentUrl(text, finalUrl),
      mediaSequence: this.parseMediaSequence(text),
      keyInfo: this.parseKeyInfo(text, finalUrl)
    };
  }

  async downloadPlaylistTrack(track) {
    let initSegmentBuffer = null;

    if (track.initSegmentUrl) {
      console.log(`[Downloader] Fragmented MP4 (fMP4) ${track.label} stream detected. Fetching initialization header: ${track.initSegmentUrl.url}`);
      try {
        const initBuffer = await this.fetchSegmentWithRetry(track.initSegmentUrl.url, track.initSegmentUrl.range, 2);
        initSegmentBuffer = initBuffer;
        this.downloadedBytes += initBuffer.byteLength;
        console.log("[Downloader] Initialization segment downloaded successfully.");
      } catch (err) {
        console.error("[Downloader] Failed to fetch HLS initialization segment:", err);
        throw new Error(`Failed downloading initialization segment: ${err.message}`);
      }
    }

    const keyCache = {};
    const getCryptoKey = async (keyInfo) => {
      if (!keyInfo) return null;
      const cacheKey = keyInfo.uri;
      if (keyCache[cacheKey]) return keyCache[cacheKey];

      try {
        console.log(`[Decryptor] Fetching HLS decryption key from: ${keyInfo.uri}`);
        const keyBytes = await this.fetchKeyBytes(keyInfo.uri);
        const cryptoKey = await this.importCryptoKey(keyBytes);
        keyCache[cacheKey] = cryptoKey;
        return cryptoKey;
      } catch (err) {
        console.error(`[Decryptor] Failed to load encryption key from ${keyInfo.uri}:`, err);
        throw new Error(`Failed to load decryption key: ${err.message}`);
      }
    };

    const buffers = new Array(track.segments.length);
    const CONCURRENCY_LIMIT = 3;
    const queue = track.segments.map((segment, index) => ({ ...segment, index }));
    
    const downloadWorker = async () => {
      while (queue.length > 0 && !this.cancelled) {
        const item = queue.shift();
        if (!item) break;
        
        try {
          if (item.index === 0) {
            console.log('[HLS] Fetching segment 0:', {
              resolvedUrl: item.url,
              playlistBaseUrl: track.finalUrl || track.url,
              range: item.range
            });
          }
          const rawBuffer = await this.fetchSegmentWithRetry(item.url, item.range, 2);
          let finalBuffer = rawBuffer;
          
          if (item.keyInfo) {
            const segCryptoKey = await getCryptoKey(item.keyInfo);
            if (segCryptoKey) {
              let iv;
              if (item.keyInfo.ivHex) {
                iv = this.parseHexIV(item.keyInfo.ivHex);
              } else {
                iv = this.getSegmentIV(track.mediaSequence + item.index);
              }
              finalBuffer = await this.decryptSegment(rawBuffer, segCryptoKey, iv);
            }
          }

          buffers[item.index] = finalBuffer;
          this.downloadedBytes += finalBuffer.byteLength;
          
          this.downloadedSegments++;
          this.progress = Math.round((this.downloadedSegments / this.totalSegments) * 100);
          this.onProgress({ percentage: this.progress, downloadedBytes: this.downloadedBytes });
        } catch (e) {
          if (this.cancelled) return;
          console.error(`[Downloader] Segment ${item.index} failed permanently. Url: ${item.url}`, e);
          throw new Error(`Failed downloading segment ${item.index} (${item.url}): ${e.message}`);
        }
      }
    };

    const workers = Array(Math.min(CONCURRENCY_LIMIT, track.segments.length))
      .fill(null)
      .map(() => downloadWorker());

    await Promise.all(workers);

    if (this.cancelled) {
      throw new Error("Download aborted.");
    }

    return { ...track, buffers, initSegmentBuffer };
  }

  async fetchSegmentWithRetry(url, range, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.fetchArrayBuffer(url, range);
      } catch (err) {
        if (this.cancelled) throw err;
        if (attempt === retries) throw err;
        
        console.warn(`[Downloader] Segment fetch failed, retrying (${attempt + 1}/${retries}). Url: ${url}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  isLikelyTransportStream(buffer) {
    const bytes = new Uint8Array(buffer);
    return bytes.length >= 188 && bytes[0] === 0x47 && (bytes[188] === 0x47 || bytes.length < 376);
  }

  isLikelyAac(buffer) {
    const bytes = new Uint8Array(buffer);
    return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  }

  transmuxTransportStream(videoTrack, audioTrack = null) {
    const muxjs = globalThis.muxjs;
    if (!muxjs || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
      throw new Error("MP4 transmuxer is not available in the offscreen document.");
    }

    const collectTransmuxedTrack = (track) => {
      const segments = track.segments;
      const buffers = track.buffers;
      const trackOutput = {
        initSegment: null,
        dataBuffers: [],
        track: null
      };

      // Group segments by discontinuity boundary to reset the transmuxer timeline cleanly
      const groups = [];
      let currentGroup = [];

      segments.forEach((seg, idx) => {
        if (seg.isDiscontinuity && currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
        currentGroup.push({ data: buffers[idx] });
      });
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }

      groups.forEach((group) => {
        const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
        transmuxer.on("data", (segment) => {
          if (segment.track) {
            trackOutput.track = segment.track;
          }
          if (segment.initSegment && !trackOutput.initSegment) {
            trackOutput.initSegment = segment.initSegment;
          }
          if (segment.data) {
            trackOutput.dataBuffers.push(segment.data);
          }
        });

        group.forEach((item) => {
          if (item.data) {
            transmuxer.push(new Uint8Array(item.data));
          }
        });
        transmuxer.flush();
      });

      return trackOutput;
    };

    const buildCombinedInitSegment = (tracks) => {
      if (typeof muxjs.mp4.initSegment !== "function") {
        return null;
      }
      try {
        return muxjs.mp4.initSegment(tracks);
      } catch (err) {
        console.warn("[Downloader] Combined MP4 init segment generation failed:", err);
        return null;
      }
    };

    const outputBuffers = [];

    if (audioTrack) {
      const videoTrackOutput = collectTransmuxedTrack(videoTrack);
      const audioTrackOutput = collectTransmuxedTrack(audioTrack);

      const combinedInitSegment = buildCombinedInitSegment(
        [videoTrackOutput.track, audioTrackOutput.track].filter(Boolean)
      );

      if (combinedInitSegment) {
        outputBuffers.push(combinedInitSegment);
      } else if (videoTrackOutput.initSegment) {
        outputBuffers.push(videoTrackOutput.initSegment);
      } else if (audioTrackOutput.initSegment) {
        outputBuffers.push(audioTrackOutput.initSegment);
      }

      outputBuffers.push(...videoTrackOutput.dataBuffers);
      outputBuffers.push(...audioTrackOutput.dataBuffers);
    } else {
      const videoTrackOutput = collectTransmuxedTrack(videoTrack);
      if (videoTrackOutput.initSegment) {
        outputBuffers.push(videoTrackOutput.initSegment);
      }
      outputBuffers.push(...videoTrackOutput.dataBuffers);
    }

    if (outputBuffers.length === 0) {
      throw new Error("Transmuxing failed: no MP4 data was produced from HLS segments.");
    }

    return outputBuffers;
  }

  parseKeyLine(line, playlistUrl) {
    const methodMatch = line.match(/METHOD=([^,\s]+)/i);
    const uriMatch = line.match(/URI=["']([^"']+)["']/i);
    const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);

    if (methodMatch && methodMatch[1] === "AES-128" && uriMatch) {
      return {
        method: "AES-128",
        uri: this.resolveUrl(playlistUrl, uriMatch[1]),
        ivHex: ivMatch ? ivMatch[1] : null
      };
    }
    if (methodMatch && methodMatch[1] === "NONE") {
      return null;
    }
    return undefined; // No change if METHOD isn't matched
  }

  parseSegments(playlistText, playlistUrl = this.m3u8Url) {
    const lines = playlistText.split("\n");
    const segments = [];
    let pendingRange = null;
    let lastRangeEnd = 0;
    let lastRangeUrl = null;
    
    let activeKey = null;
    let isDiscontinuity = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXT-X-DISCONTINUITY")) {
        isDiscontinuity = true;
        continue;
      }

      if (line.startsWith("#EXT-X-KEY:")) {
        const parsedKey = this.parseKeyLine(line, playlistUrl);
        if (parsedKey !== undefined) {
          activeKey = parsedKey;
        }
        continue;
      }

      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingRange = line.substring("#EXT-X-BYTERANGE:".length).trim();
        continue;
      }
      
      if (line.startsWith("#EXTINF:")) {
        let urlLine = "";
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine.startsWith("#EXT-X-DISCONTINUITY")) {
            isDiscontinuity = true;
            continue;
          }
          if (nextLine.startsWith("#EXT-X-KEY:")) {
            const parsedKey = this.parseKeyLine(nextLine, playlistUrl);
            if (parsedKey !== undefined) {
              activeKey = parsedKey;
            }
            continue;
          }
          if (nextLine.startsWith("#EXT-X-BYTERANGE:")) {
            pendingRange = nextLine.substring("#EXT-X-BYTERANGE:".length).trim();
            continue;
          }
          if (nextLine && !nextLine.startsWith("#")) {
            urlLine = nextLine;
            i = j;
            break;
          }
        }

        if (urlLine) {
          const url = this.resolveUrl(playlistUrl, urlLine);
          if (segments.length === 0) {
            console.log('[HLS] Segment 0 resolved at extraction:', {
              rawLine: urlLine,
              resolvedUrl: url,
              playlistUrl: playlistUrl
            });
          }
          const range = pendingRange ? this.parseByteRange(pendingRange, url === lastRangeUrl ? lastRangeEnd : 0) : null;
          if (range) {
            lastRangeEnd = range.end + 1;
            lastRangeUrl = url;
          }
          segments.push({
            url,
            range,
            keyInfo: activeKey ? { ...activeKey } : null,
            isDiscontinuity: isDiscontinuity
          });
          isDiscontinuity = false; // Reset discontinuity after consumption
          pendingRange = null;
        }
      }
    }
    
    return segments;
  }

  parseMediaSequence(playlistText) {
    const match = playlistText.match(/#EXT-X-MEDIA-SEQUENCE:([0-9]+)/i);
    return match ? parseInt(match[1]) : 0;
  }

  parseInitSegmentUrl(playlistText, playlistUrl = this.m3u8Url) {
    const lines = playlistText.split("\n");
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith("#EXT-X-MAP:")) {
        const uriMatch = line.match(/URI=["']([^"']+)["']/i);
        const byteRangeMatch = line.match(/BYTERANGE=["']([^"']+)["']/i);
        if (uriMatch) {
          return {
            url: this.resolveUrl(playlistUrl, uriMatch[1]),
            range: byteRangeMatch ? this.parseByteRange(byteRangeMatch[1], 0) : null
          };
        }
      }
    }
    return null;
  }

  parseByteRange(byteRangeText, nextOffset) {
    const match = byteRangeText.match(/^(\d+)(?:@(\d+))?$/);
    if (!match) return null;

    const length = parseInt(match[1], 10);
    const start = match[2] ? parseInt(match[2], 10) : nextOffset;
    return { start, end: start + length - 1 };
  }

  parseKeyInfo(playlistText, playlistUrl = this.m3u8Url) {
    const lines = playlistText.split("\n");
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith("#EXT-X-KEY:")) {
        const methodMatch = line.match(/METHOD=([^,\s]+)/i);
        const uriMatch = line.match(/URI=["']([^"']+)["']/i);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);

        if (methodMatch && methodMatch[1] === "AES-128" && uriMatch) {
          return {
            method: "AES-128",
            uri: this.resolveUrl(playlistUrl, uriMatch[1]),
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      }
    }
    return null;
  }

  async fetchKeyBytes(keyUrl) {
    const res = await fetch(keyUrl, { signal: this.abortController.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to load key from: ${keyUrl}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async importCryptoKey(keyBytes) {
    return await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
  }

  getSegmentIV(sequenceNum) {
    const iv = new Uint8Array(16);
    iv[12] = (sequenceNum >> 24) & 0xff;
    iv[13] = (sequenceNum >> 16) & 0xff;
    iv[14] = (sequenceNum >> 8) & 0xff;
    iv[15] = sequenceNum & 0xff;
    return iv;
  }

  parseHexIV(hexString) {
    let hex = hexString;
    if (hex.length > 32) hex = hex.substring(0, 32);
    while (hex.length < 32) hex = "0" + hex;
    
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return iv;
  }

  async decryptSegment(encryptedBuffer, cryptoKey, iv) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-CBC",
          iv: iv
        },
        cryptoKey,
        encryptedBuffer
      );
      return decrypted;
    } catch (e) {
      console.error("[Decryptor] Decryption failed:", e);
      throw new Error(`Decryption failed: ${e.message}`);
    }
  }

  resolveUrl(baseUrl, relativeUrl) {
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
      let urlWithParams = relativeUrl;
      if (!relativeUrl.includes("?")) {
        const baseQueryIndex = baseUrl.indexOf("?");
        if (baseQueryIndex !== -1) {
          urlWithParams += baseUrl.substring(baseQueryIndex);
        }
      }
      
      const parts = baseUrl.split("/");
      parts.pop();
      return parts.join("/") + "/" + urlWithParams;
    }
  }
}
