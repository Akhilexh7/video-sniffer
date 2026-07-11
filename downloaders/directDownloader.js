// downloaders/directDownloader.js

export class DirectMediaDownloader {
  constructor(url, onProgress, tabId = null, frameId = null, expectedSize = null) {
    this.url = url;
    this.onProgress = onProgress || (() => {});
    this.tabId = tabId;
    this.frameId = frameId;
    this.expectedSize = expectedSize;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.downloadedBytes = 0;
  }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    console.log("[DirectMediaDownloader] Download cancelled by user.");
  }

  async fetchWithProxy(url, options = {}, responseType = "arraybuffer") {
    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          // Remove non-serializable signal
          const cleanOptions = { ...options };
          delete cleanOptions.signal;

          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
            frameId: this.frameId,
            url: url,
            responseType: responseType,
            options: cleanOptions
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

              const headerMap = response.headers || {};
              resolve({
                ok: true,
                status: response.status,
                headers: {
                  get: (name) => headerMap[name.toLowerCase()] || null
                },
                arrayBuffer: async () => bytes.buffer,
                blob: async () => new Blob([bytes])
              });
            } else {
              reject(new Error(response ? response.error : "Failed proxy fetch"));
            }
          });
        });
      } catch (e) {
        console.warn(`[DirectMediaDownloader] Proxy fetch failed. Falling back to direct fetch.`, e);
      }
    }

    // Direct fetch fallback if no tabId or chrome runtime is unavailable (e.g. tests or standalone)
    const res = await fetch(url, options);
    return res;
  }

  async fetchArrayBuffer(url, start = null, end = null) {
    const headers = (start !== null && end !== null) ? { Range: `bytes=${start}-${end}` } : {};
    const res = await this.fetchWithProxy(url, {
      signal: this.abortController.signal,
      headers: headers
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
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
      if (mimeType.includes("webm") || mimeType.includes("opus")) {
        extension = "webm";
      } else {
        extension = "m4a";
      }
    }

    if (isRangeSupported && contentLength && contentLength > 0) {
      console.log(`[DirectMediaDownloader] Chunked downloading supported. Total size: ${contentLength} bytes.`);
      const blob = await this.downloadInChunks(this.url, contentLength);
      return { blob, extension, mimeType };
    } else {
      console.log("[DirectMediaDownloader] Range requests not supported or probe size missing. Streaming download.");
      const blob = await this.downloadAsStream(this.url, contentLength);
      return { blob, extension, mimeType };
    }
  }

  async probe(url) {
    try {
      const res = await this.fetchWithProxy(url, {
        method: "GET",
        headers: { Range: "bytes=0-65535" },
        signal: this.abortController.signal
      });

      if (!res.ok) {
        try { await res.arrayBuffer(); } catch (_) {}
        throw new Error(`HTTP ${res.status}`);
      }

      const isRangeSupported = res.status === 206;
      let contentLength = null;

      if (isRangeSupported) {
        const contentRange = res.headers.get("content-range");
        if (contentRange) {
          const match = contentRange.match(/bytes\s+\d+-\d+\/(\d+|\*)/i);
          if (match && match[1] !== "*") {
            contentLength = parseInt(match[1], 10);
          }
        }
      }

      if (!contentLength) {
        const len = res.headers.get("content-length");
        if (len) {
          contentLength = parseInt(len, 10);
        }
      }

      // If range requests are supported, but we only got the chunk size (e.g. <= 65536 bytes)
      // because Content-Range was hidden due to CORS, and we have a larger expectedSize,
      // override contentLength with expectedSize.
      if (isRangeSupported && this.expectedSize && (!contentLength || contentLength < this.expectedSize)) {
        console.log(`[DirectMediaDownloader] Overriding probed size (${contentLength}) with expected size (${this.expectedSize}) due to CORS/Range chunk bounds.`);
        contentLength = this.expectedSize;
      }

      const contentType = res.headers.get("content-type") || "";

      // Discard body to desync connection pools properly
      try {
        await res.arrayBuffer();
      } catch (err) {
        console.warn("[DirectMediaDownloader] Error draining probe response body:", err);
      }

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
    // If we have tabId, run streaming download via fetchWithProxy blob fallback to bypass cross-origin restrictions
    if (this.tabId) {
      const res = await this.fetchWithProxy(url, {
        signal: this.abortController.signal
      }, "arraybuffer");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      this.onProgress({ percentage: 100, downloadedBytes: blob.size });
      return blob;
    }

    // Direct streaming fetch for background service worker or generic downloading
    const res = await fetch(url, {
      signal: this.abortController.signal
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
  }
}
