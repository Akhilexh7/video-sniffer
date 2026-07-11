// downloader.js

export class HlsDownloader {
  constructor(m3u8Url, onProgress, audioM3u8Url = null, tabId = null) {
    this.m3u8Url = m3u8Url;
    this.audioM3u8Url = audioM3u8Url;
    this.onProgress = onProgress || (() => {});
    this.tabId = tabId;
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
              resolve(response.data);
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
    return await response.text();
  }

  async fetchArrayBuffer(url, range = null) {
    const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
    
    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
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

  // Aborts all ongoing HTTP requests and marks download as cancelled
  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    console.log("[Downloader] Download cancelled by user.");
  }

  getProgress() {
    return this.progress;
  }

  // Initiates segment parsing, concurrency-limited download pool, decryption, and buffer merging
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
      if (downloadedVideoTrack.initSegmentBuffer || downloadedAudioTrack.initSegmentBuffer) {
        throw new Error("This HLS stream stores audio and video as separate fragmented MP4 tracks. Merging those tracks requires an MP4 muxer that is not bundled yet.");
      }

      if (
        this.isLikelyTransportStream(downloadedVideoTrack.buffers[0]) &&
        (this.isLikelyTransportStream(downloadedAudioTrack.buffers[0]) || this.isLikelyAac(downloadedAudioTrack.buffers[0]))
      ) {
        const mp4Buffers = this.transmuxTransportStream(downloadedVideoTrack.buffers, downloadedAudioTrack.buffers);
        return {
          blob: new Blob(mp4Buffers, { type: "video/mp4" }),
          extension: "mp4",
          mimeType: "video/mp4"
        };
      }

      throw new Error("Unsupported separate audio/video HLS segment format.");
    }

    // fMP4 HLS segments are already MP4 fragments. MPEG-TS HLS segments must be
    // transmuxed first; concatenating TS bytes into a .mp4 creates an unplayable file.
    if (downloadedVideoTrack.initSegmentBuffer) {
      const finalBuffers = [downloadedVideoTrack.initSegmentBuffer, ...downloadedVideoTrack.buffers];
      return {
        blob: new Blob(finalBuffers, { type: "video/mp4" }),
        extension: "mp4",
        mimeType: "video/mp4"
      };
    }

    if (this.isLikelyTransportStream(downloadedVideoTrack.buffers[0])) {
      const mp4Buffers = this.transmuxTransportStream(downloadedVideoTrack.buffers);
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

    let text;
    try {
      text = await this.fetchText(url);
    } catch (err) {
      throw new Error(`Failed to load ${label} media playlist: ${err.message}`);
    }
    const segments = this.parseSegments(text, url);

    return {
      label,
      url,
      segments,
      initSegmentUrl: this.parseInitSegmentUrl(text, url),
      mediaSequence: this.parseMediaSequence(text),
      keyInfo: this.parseKeyInfo(text, url)
    };
  }

  async downloadPlaylistTrack(track) {
    let initSegmentBuffer = null;
    let cryptoKey = null;
    let keyIvHex = null;

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

    if (track.keyInfo) {
      console.log(`[Decryptor] Encrypted ${track.label} HLS stream detected (AES-128). URI: ${track.keyInfo.uri}`);
      try {
        const keyBytes = await this.fetchKeyBytes(track.keyInfo.uri);
        cryptoKey = await this.importCryptoKey(keyBytes);
        keyIvHex = track.keyInfo.ivHex;
        console.log("[Decryptor] Decryption key successfully imported.");
      } catch (err) {
        console.error("[Decryptor] Failed to load encryption keys:", err);
        throw new Error(`Failed to initialize decryption keys: ${err.message}`);
      }
    }

    const buffers = new Array(track.segments.length);

    // Concurrency limit of 3 downloads
    const CONCURRENCY_LIMIT = 3;
    const queue = track.segments.map((segment, index) => ({ ...segment, index }));
    
    const downloadWorker = async () => {
      while (queue.length > 0 && !this.cancelled) {
        const item = queue.shift();
        if (!item) break;
        
        try {
          const rawBuffer = await this.fetchSegmentWithRetry(item.url, item.range, 2);
          
          let finalBuffer = rawBuffer;
          
          // 3. Perform AES decryption if key exists
          if (cryptoKey) {
            let iv;
            if (keyIvHex) {
              iv = this.parseHexIV(keyIvHex);
            } else {
              // HLS standard: IV equals the segment sequence number
              iv = this.getSegmentIV(track.mediaSequence + item.index);
            }
            finalBuffer = await this.decryptSegment(rawBuffer, cryptoKey, iv);
          }

          buffers[item.index] = finalBuffer;
          this.downloadedBytes += finalBuffer.byteLength;
          
          this.downloadedSegments++;
          this.progress = Math.round((this.downloadedSegments / this.totalSegments) * 100);
          this.onProgress({ percentage: this.progress, downloadedBytes: this.downloadedBytes });
        } catch (e) {
          if (this.cancelled) return;
          console.error(`[Downloader] Segment ${item.index} failed permanently:`, e);
          throw new Error(`Failed downloading segment ${item.index}: ${e.message}`);
        }
      }
    };

    // Run parallel download workers
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
        const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : undefined;
        const res = await fetch(url, { signal: this.abortController.signal, headers, credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (range && res.status !== 206) {
          throw new Error(`HTTP ${res.status}: server did not return requested byte range`);
        }
        return await res.arrayBuffer();
      } catch (err) {
        if (this.cancelled) throw err;
        if (attempt === retries) throw err;
        
        console.warn(`[Downloader] Segment fetch failed, retrying (${attempt + 1}/${retries}). Url: ${url}`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
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

  transmuxTransportStream(videoBuffers, audioBuffers = null) {
    const muxjs = globalThis.muxjs;
    if (!muxjs || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
      throw new Error("MP4 transmuxer is not available in the offscreen document.");
    }

    const collectTransmuxedTrack = (buffers) => {
      const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: false });
      const trackOutput = {
        initSegment: null,
        dataBuffers: [],
        track: null
      };

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

      buffers.forEach((buffer) => {
        transmuxer.push(new Uint8Array(buffer));
      });
      transmuxer.flush();

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

    if (audioBuffers) {
      const videoTrackOutput = collectTransmuxedTrack(videoBuffers);
      const audioTrackOutput = collectTransmuxedTrack(audioBuffers);

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
      const videoTrackOutput = collectTransmuxedTrack(videoBuffers);
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

  // Parse lines to extract segment paths
  parseSegments(playlistText, playlistUrl = this.m3u8Url) {
    const lines = playlistText.split("\n");
    const segments = [];
    let pendingRange = null;
    let lastRangeEnd = 0;
    let lastRangeUrl = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingRange = line.substring("#EXT-X-BYTERANGE:".length).trim();
        continue;
      }
      
      if (line.startsWith("#EXTINF:")) {
        // The segment URL is on the next non-empty line
        let urlLine = "";
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine.startsWith("#EXT-X-BYTERANGE:")) {
            pendingRange = nextLine.substring("#EXT-X-BYTERANGE:".length).trim();
            continue;
          }
          if (nextLine && !nextLine.startsWith("#")) {
            urlLine = nextLine;
            i = j; // Advance main loop index
            break;
          }
        }

        if (urlLine) {
          const url = this.resolveUrl(playlistUrl, urlLine);
          const range = pendingRange ? this.parseByteRange(pendingRange, url === lastRangeUrl ? lastRangeEnd : 0) : null;
          if (range) {
            lastRangeEnd = range.end + 1;
            lastRangeUrl = url;
          }
          segments.push({ url, range });
          pendingRange = null;
        }
      }
    }
    
    return segments;
  }

  // Parses starting segment sequence number
  parseMediaSequence(playlistText) {
    const match = playlistText.match(/#EXT-X-MEDIA-SEQUENCE:([0-9]+)/i);
    return match ? parseInt(match[1]) : 0;
  }

  // Parses fMP4 HLS initialization map segment URL from manifest
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

  // Parses key method, uri, and custom IV from manifest
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

  // Fetches HLS binary key bytes
  async fetchKeyBytes(keyUrl) {
    const res = await fetch(keyUrl, { signal: this.abortController.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to load key from: ${keyUrl}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Imports key bytes into Web Crypto API Key object
  async importCryptoKey(keyBytes) {
    return await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
  }

  // Returns sequence number represented as a 16-byte big-endian IV
  getSegmentIV(sequenceNum) {
    const iv = new Uint8Array(16);
    iv[12] = (sequenceNum >> 24) & 0xff;
    iv[13] = (sequenceNum >> 16) & 0xff;
    iv[14] = (sequenceNum >> 8) & 0xff;
    iv[15] = sequenceNum & 0xff;
    return iv;
  }

  // Converts a hex string into a Uint8Array IV (16 bytes)
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

  // Decrypts segment using AES-CBC-128
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
      if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
        return relativeUrl;
      }
      
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

export class DirectMediaMerger {
  constructor(videoUrl, audioUrl) {
    this.videoUrl = videoUrl;
    this.audioUrl = audioUrl;
  }

  async start() {
    if (!this.videoUrl || !this.audioUrl) {
      throw new Error("Both video and audio URLs are required for media merging.");
    }

    const videoElement = document.createElement("video");
    const audioElement = document.createElement("audio");
    videoElement.crossOrigin = "anonymous";
    audioElement.crossOrigin = "anonymous";
    videoElement.muted = true;
    videoElement.playsInline = true;
    videoElement.preload = "auto";
    audioElement.preload = "auto";

    const waitForEvent = (element, eventName) => {
      return new Promise((resolve, reject) => {
        const onEvent = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`Failed while waiting for ${eventName}.`));
        };
        const cleanup = () => {
          element.removeEventListener(eventName, onEvent);
          element.removeEventListener("error", onError);
        };

        element.addEventListener(eventName, onEvent, { once: true });
        element.addEventListener("error", onError, { once: true });
      });
    };

    videoElement.src = this.videoUrl;
    audioElement.src = this.audioUrl;

    await Promise.all([
      waitForEvent(videoElement, "loadedmetadata"),
      waitForEvent(audioElement, "loadedmetadata")
    ]);

    const captureStream = (element) => {
      if (typeof element.captureStream === "function") return element.captureStream();
      if (typeof element.mozCaptureStream === "function") return element.mozCaptureStream();
      return null;
    };

    const videoStream = captureStream(videoElement);
    const audioStream = captureStream(audioElement);
    if (!videoStream || !audioStream) {
      throw new Error("Media capture is not supported in this browser context.");
    }

    const combinedStream = new MediaStream();
    videoStream.getVideoTracks().forEach((track) => combinedStream.addTrack(track));
    audioStream.getAudioTracks().forEach((track) => combinedStream.addTrack(track));

    if (combinedStream.getVideoTracks().length === 0 || combinedStream.getAudioTracks().length === 0) {
      throw new Error("Failed to capture both audio and video tracks.");
    }

    const mimeType = this.pickRecorderMimeType();
    const recorder = new MediaRecorder(combinedStream, mimeType ? { mimeType } : undefined);
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const stopPromise = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
    });

    await Promise.all([videoElement.play(), audioElement.play()]);

    recorder.start(1000);
    await Promise.all([
      waitForEvent(videoElement, "ended"),
      waitForEvent(audioElement, "ended")
    ]);

    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    await stopPromise;

    if (chunks.length === 0) {
      throw new Error("No merged media data was recorded.");
    }

    const outputMimeType = recorder.mimeType || mimeType || "video/webm";
    const extension = outputMimeType.includes("mp4") ? "mp4" : "webm";

    return {
      blob: new Blob(chunks, { type: outputMimeType }),
      extension,
      mimeType: outputMimeType
    };
  }

  pickRecorderMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];

    for (const candidate of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return "video/webm";
  }
}


export class DirectMediaDownloader {
  constructor(url, onProgress, tabId = null) {
    this.url = url;
    this.onProgress = onProgress || (() => {});
    this.tabId = tabId;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.downloadedBytes = 0;
  }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    console.log("[DirectMediaDownloader] Download cancelled by user.");
  }

  async fetchArrayBuffer(url, start = null, end = null) {
    const headers = (start !== null && end !== null) ? { Range: `bytes=${start}-${end}` } : {};
    
    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
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
        console.warn(`[DirectMediaDownloader] Proxy fetch failed for chunk. Falling back to direct fetch.`, e);
      }
    }
    
    const res = await fetch(url, {
      signal: this.abortController.signal,
      headers: (start !== null && end !== null) ? { Range: `bytes=${start}-${end}` } : undefined,
      credentials: 'include'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  }

  async fetchBlobViaProxy(url) {
    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
            url: url,
            responseType: "arraybuffer",
            options: {
              signal: this.abortController.signal,
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
              resolve(new Blob([bytes]));
            } else {
              reject(new Error(response ? response.error : "Failed proxy fetch"));
            }
          });
        });
      } catch (e) {
        console.warn(`[DirectMediaDownloader] Proxy fetch failed for streaming. Falling back to direct fetch.`, e);
      }
    }

    const res = await fetch(url, {
      signal: this.abortController.signal,
      credentials: 'include'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  }

  async start() {
    let probeResult;
    try {
      probeResult = await this.probe(this.url);
    } catch (err) {
      console.warn("[DirectMediaDownloader] Probe failed, attempting direct single stream:", err);
      probeResult = { isRangeSupported: false, contentLength: null, contentType: "" };
    }

    const { isRangeSupported, contentLength, contentType } = probeResult;

    let extension = "mp4";
    let mimeType = contentType || "video/mp4";
    if (mimeType.includes("video/webm")) {
      extension = "webm";
    } else if (mimeType.includes("video/x-matroska") || this.url.toLowerCase().includes(".mkv")) {
      extension = "mkv";
      mimeType = "video/x-matroska";
    } else if (mimeType.includes("audio/")) {
      extension = "mp3";
    }

    if (isRangeSupported && contentLength && contentLength > 0) {
      console.log(`[DirectMediaDownloader] Chunked downloading supported. Total size: ${contentLength} bytes.`);
      const blob = await this.downloadInChunks(this.url, contentLength);
      return { blob, extension, mimeType };
    } else {
      console.log("[DirectMediaDownloader] Range requests not supported. Streaming download.");
      const blob = await this.downloadAsStream(this.url, contentLength);
      return { blob, extension, mimeType };
    }
  }

  async probe(url) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: this.abortController.signal,
        credentials: "include"
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const isRangeSupported = res.status === 206;
      let contentLength = null;

      if (isRangeSupported) {
        const contentRange = res.headers.get("Content-Range");
        if (contentRange) {
          const match = contentRange.match(/bytes\s+\d+-\d+\/(\d+|\*)/i);
          if (match && match[1] !== "*") {
            contentLength = parseInt(match[1], 10);
          }
        }
      }

      if (!contentLength) {
        const len = res.headers.get("Content-Length");
        if (len) {
          contentLength = parseInt(len, 10);
        }
      }

      const contentType = res.headers.get("Content-Type") || "";
      return { isRangeSupported, contentLength, contentType };
    } catch (e) {
      console.warn("[DirectMediaDownloader] Probe fetch error:", e);
      return { isRangeSupported: false, contentLength: null, contentType: "" };
    }
  }

  async downloadInChunks(url, contentLength) {
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
    const totalChunks = Math.ceil(contentLength / CHUNK_SIZE);
    const chunks = new Array(totalChunks);
    this.downloadedBytes = 0;

    const queue = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1);
      queue.push({ index: i, start, end });
    }

    const CONCURRENCY_LIMIT = 3;
    const downloadWorker = async () => {
      while (queue.length > 0 && !this.cancelled) {
        const item = queue.shift();
        if (!item) break;

        try {
          const buffer = await this.fetchChunkWithRetry(url, item.start, item.end, 2);
          chunks[item.index] = buffer;
          this.downloadedBytes += buffer.byteLength;
          
          const percentage = Math.round((this.downloadedBytes / contentLength) * 100);
          this.onProgress({ percentage, downloadedBytes: this.downloadedBytes });
        } catch (e) {
          if (this.cancelled) return;
          console.error(`[DirectMediaDownloader] Chunk ${item.index} failed:`, e);
          throw new Error(`Failed downloading chunk ${item.index}: ${e.message}`);
        }
      }
    };

    const workers = Array(Math.min(CONCURRENCY_LIMIT, totalChunks))
      .fill(null)
      .map(() => downloadWorker());

    await Promise.all(workers);

    if (this.cancelled) {
      throw new Error("Download aborted.");
    }

    return new Blob(chunks);
  }

  async fetchChunkWithRetry(url, start, end, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.fetchArrayBuffer(url, start, end);
      } catch (err) {
        if (this.cancelled) throw err;
        if (attempt === retries) throw err;

        console.warn(`[DirectMediaDownloader] Chunk fetch failed, retrying (${attempt + 1}/${retries}). Range: ${start}-${end}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async downloadAsStream(url, contentLength) {
    try {
      const res = await fetch(url, {
        signal: this.abortController.signal,
        credentials: "include"
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const chunks = [];
      this.downloadedBytes = 0;
      const totalBytes = contentLength || parseInt(res.headers.get("Content-Length") || "0", 10);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        this.downloadedBytes += value.length;

        const percentage = totalBytes > 0 ? Math.round((this.downloadedBytes / totalBytes) * 100) : 0;
        this.onProgress({ percentage, downloadedBytes: this.downloadedBytes });
      }

      if (this.cancelled) {
        throw new Error("Download aborted.");
      }

      return new Blob(chunks);
    } catch (e) {
      console.warn("[DirectMediaDownloader] Streaming download failed, falling back to proxy fetch:", e);
      const blob = await this.fetchBlobViaProxy(url);
      this.onProgress({ percentage: 100, downloadedBytes: blob.size });
      return blob;
    }
  }
}