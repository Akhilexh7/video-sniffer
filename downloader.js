// downloader.js

export class HlsDownloader {
  constructor(m3u8Url, onProgress) {
    this.m3u8Url = m3u8Url;
    this.onProgress = onProgress || (() => {});
    this.cancelled = false;
    this.abortController = new AbortController();
    this.progress = 0;
    this.totalSegments = 0;
    this.downloadedSegments = 0;
    
    // Encryption key details
    this.cryptoKey = null;
    this.keyIvHex = null;
    this.mediaSequence = 0;
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
    console.log(`[Downloader] Loading media playlist from: ${this.m3u8Url}`);
    
    const response = await fetch(this.m3u8Url, { signal: this.abortController.signal });
    if (!response.ok) {
      throw new Error(`Failed to load media playlist: ${response.statusText}`);
    }

    const text = await response.text();
    const segments = this.parseSegments(text);
    
    this.totalSegments = segments.length;
    console.log(`[Downloader] Found ${this.totalSegments} video segments to fetch.`);
    
    if (this.totalSegments === 0) {
      throw new Error("No video segments detected in playlist.");
    }

    // 1. Detect and parse HLS AES-128 Encryption details
    this.mediaSequence = this.parseMediaSequence(text);
    const keyInfo = this.parseKeyInfo(text);
    if (keyInfo) {
      console.log(`[Decryptor] Encrypted HLS stream detected (AES-128). URI: ${keyInfo.uri}`);
      try {
        const keyBytes = await this.fetchKeyBytes(keyInfo.uri);
        this.cryptoKey = await this.importCryptoKey(keyBytes);
        this.keyIvHex = keyInfo.ivHex;
        console.log("[Decryptor] Decryption key successfully imported.");
      } catch (err) {
        console.error("[Decryptor] Failed to load encryption keys:", err);
        throw new Error(`Failed to initialize decryption keys: ${err.message}`);
      }
    }

    const buffers = new Array(this.totalSegments);
    this.downloadedSegments = 0;
    this.progress = 0;

    // Concurrency limit of 3 downloads
    const CONCURRENCY_LIMIT = 3;
    const queue = segments.map((url, index) => ({ url, index }));
    
    const downloadWorker = async () => {
      while (queue.length > 0 && !this.cancelled) {
        const item = queue.shift();
        if (!item) break;
        
        try {
          const rawBuffer = await this.fetchSegmentWithRetry(item.url, 2);
          
          let finalBuffer = rawBuffer;
          
          // 2. Perform AES decryption if key exists
          if (this.cryptoKey) {
            let iv;
            if (this.keyIvHex) {
              iv = this.parseHexIV(this.keyIvHex);
            } else {
              // HLS standard: IV equals the segment sequence number
              iv = this.getSegmentIV(this.mediaSequence + item.index);
            }
            finalBuffer = await this.decryptSegment(rawBuffer, this.cryptoKey, iv);
          }

          buffers[item.index] = finalBuffer;
          
          this.downloadedSegments++;
          this.progress = Math.round((this.downloadedSegments / this.totalSegments) * 100);
          this.onProgress(this.progress);
        } catch (e) {
          if (this.cancelled) return;
          console.error(`[Downloader] Segment ${item.index} failed permanently:`, e);
          throw new Error(`Failed downloading segment ${item.index}: ${e.message}`);
        }
      }
    };

    // Run parallel download workers
    const workers = Array(Math.min(CONCURRENCY_LIMIT, this.totalSegments))
      .fill(null)
      .map(() => downloadWorker());

    await Promise.all(workers);

    if (this.cancelled) {
      throw new Error("Download aborted.");
    }

    console.log("[Downloader] All segments downloaded and decrypted. Transmuxing streams to MP4...");
    
    let finalBlob;
    if (typeof muxjs !== "undefined") {
      console.log("[Downloader] mux.js detected. Transmuxing TS to MP4...");
      try {
        const transmuxer = new muxjs.mp4.Transmuxer();
        const mp4Segments = [];
        let initSegment = null;

        transmuxer.on('data', (event) => {
          // Accept all event data payloads (combined, video, audio) to prevent 0-byte saves for demuxed streams
          if (event.data) {
            mp4Segments.push(event.data);
          }
          if (event.initSegment) {
            initSegment = event.initSegment;
          }
        });

        // Feed each decrypted TS segment buffer sequentially to the transmuxer
        for (let i = 0; i < buffers.length; i++) {
          if (buffers[i]) {
            transmuxer.push(new Uint8Array(buffers[i]));
            transmuxer.flush();
          }
        }

        const mp4Data = [];
        if (initSegment) {
          mp4Data.push(initSegment);
        }
        mp4Data.push(...mp4Segments);

        finalBlob = new Blob(mp4Data, { type: "video/mp4" });
        console.log("[Downloader] Transmuxing complete. Output size:", finalBlob.size);
      } catch (err) {
        console.error("[Downloader] Transmuxing failed, falling back to raw TS save:", err);
        finalBlob = new Blob(buffers, { type: "video/mp4" });
      }
    } else {
      console.warn("[Downloader] mux.js not found. Saving concatenated TS as MP4...");
      finalBlob = new Blob(buffers, { type: "video/mp4" });
    }

    return finalBlob;
  }

  async fetchSegmentWithRetry(url, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { signal: this.abortController.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } catch (err) {
        if (this.cancelled) throw err;
        if (attempt === retries) throw err;
        
        console.warn(`[Downloader] Segment fetch failed, retrying (${attempt + 1}/${retries}). Url: ${url}`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }
  }

  // Parse lines to extract segment paths
  parseSegments(playlistText) {
    const lines = playlistText.split("\n");
    const segments = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith("#EXTINF:")) {
        // The segment URL is on the next non-empty line
        let urlLine = "";
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine && !nextLine.startsWith("#")) {
            urlLine = nextLine;
            i = j; // Advance main loop index
            break;
          }
        }

        if (urlLine) {
          segments.push(this.resolveUrl(this.m3u8Url, urlLine));
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

  // Parses key method, uri, and custom IV from manifest
  parseKeyInfo(playlistText) {
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
            uri: this.resolveUrl(this.m3u8Url, uriMatch[1]),
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      }
    }
    return null;
  }

  // Fetches HLS binary key bytes
  async fetchKeyBytes(keyUrl) {
    const res = await fetch(keyUrl, { signal: this.abortController.signal });
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
      return new URL(relativeUrl, baseUrl).href;
    } catch (e) {
      if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
        return relativeUrl;
      }
      const parts = baseUrl.split("/");
      parts.pop();
      return parts.join("/") + "/" + relativeUrl;
    }
  }
}
