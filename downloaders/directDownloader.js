// downloaders/directDownloader.js
import { DiskBuffer } from './diskBuffer.js';

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
    
    // Adaptive concurrency states (Optimization 9)
    this.completedChunksCount = 0;
    this.downloadStartTime = 0;
    this.concurrencyLimit = 3;
  }

  cancel() {
    this.cancelled = true;
    this.abortController.abort();
    console.log("[DirectMediaDownloader] Download cancelled by user.");
  }

  async fetchWithProxy(url, options = {}, responseType = "arraybuffer") {
    const isYoutube = url.includes("googlevideo.com") || url.includes("youtube.com");

    if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        return await new Promise((resolve, reject) => {
          const cleanOptions = { ...options };
          delete cleanOptions.signal;

          const requestId = Math.random().toString(36).substring(2, 15);
          
          const responseListener = async (message, sender, sendResponse) => {
            if (message.action === "proxy_fetch_response" && message.requestId === requestId) {
              chrome.runtime.onMessage.removeListener(responseListener);
              if (message.success) {
                let bytes;
                if (message.responseType === "arraybuffer") {
                  if (message.data && (message.data instanceof ArrayBuffer || typeof message.data.byteLength === "number")) {
                    bytes = new Uint8Array(message.data);
                  } else {
                    reject(new Error("ArrayBuffer serialization failed (received empty/invalid object instead of ArrayBuffer)"));
                    return;
                  }
                } else {
                  try {
                    const base64Res = await fetch(`data:application/octet-stream;base64,${message.data}`);
                    const arrayBuf = await base64Res.arrayBuffer();
                    bytes = new Uint8Array(arrayBuf);
                  } catch (err) {
                    reject(new Error(`Failed to decode base64 proxy data: ${err.message}`));
                    return;
                  }
                }

                const headerMap = message.headers || {};
                resolve({
                  ok: true,
                  status: message.status,
                  headers: {
                    get: (name) => headerMap[name.toLowerCase()] || null
                  },
                  arrayBuffer: async () => bytes.buffer,
                  blob: async () => new Blob([bytes])
                });
              } else {
                const err = new Error(message.error || "Failed proxy fetch");
                if (message.status === 403) {
                  err.status = 403;
                }
                reject(err);
              }
            }
          };

          chrome.runtime.onMessage.addListener(responseListener);

          chrome.runtime.sendMessage({
            action: "background_proxy_fetch",
            tabId: this.tabId,
            frameId: this.frameId,
            url: url,
            responseType: responseType,
            requestId: requestId,
            options: cleanOptions
          }, (ack) => {
            if (chrome.runtime.lastError) {
              chrome.runtime.onMessage.removeListener(responseListener);
              reject(new Error(chrome.runtime.lastError.message));
            } else if (ack && !ack.success) {
              chrome.runtime.onMessage.removeListener(responseListener);
              reject(new Error(ack.error || "Failed to initiate proxy fetch"));
            }
          });
        });
      } catch (e) {
        console.warn(`[DirectMediaDownloader] Proxy fetch failed. Falling back to direct fetch.`, e);
      }
    }

    let res = await fetch(url, options);
    if (res.status === 403) {
      console.error('[Download Diagnostics] HTTP 403 Forbidden on direct fetch', {
        url: url,
        requestHeaders: options ? options.headers : null,
        responseHeaders: Object.fromEntries(res.headers.entries ? res.headers.entries() : []),
        timestamp: new Date().toISOString()
      });

      if (this.tabId && typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        console.warn(`[DirectMediaDownloader] Direct fetch failed with 403. Retrying without Referer...`);
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: "unregister_dnr_rules", tabId: this.tabId }, () => resolve());
        });

        try {
          const retryRes = await fetch(url, options);
          if (retryRes.ok || retryRes.status !== 403) {
            console.log(`[DirectMediaDownloader] Fetch without Referer succeeded (status ${retryRes.status})!`);
            chrome.runtime.sendMessage({
              action: "register_dnr_rules_for_tab",
              tabId: this.tabId
            });
            return retryRes;
          }
        } catch (err) {
          console.error(`[DirectMediaDownloader] Retry without Referer failed:`, err);
        }

        chrome.runtime.sendMessage({
          action: "register_dnr_rules_for_tab",
          tabId: this.tabId
        });
      }

      if (isYoutube) {
        throw new Error("YouTube download URL has expired. Please reload the YouTube page and try downloading again.");
      }
    }
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
    } else if (mimeType.includes("video/x-matroska") || (this.url && this.url.toLowerCase().includes(".mkv"))) {
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

      if (isRangeSupported && this.expectedSize && (!contentLength || contentLength < this.expectedSize)) {
        console.log(`[DirectMediaDownloader] Overriding probed size (${contentLength}) with expected size (${this.expectedSize}) due to CORS/Range chunk bounds.`);
        contentLength = this.expectedSize;
      }

      const contentType = res.headers.get("content-type") || "";

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

  supportsFileSystemAccess() {
    return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
  }

  async downloadInChunks(url, contentLength) {
    const MAX_IN_MEMORY_BYTES = 800 * 1024 * 1024; // 800MB safety ceiling
    const hasOPFS = typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory;
    if (contentLength > MAX_IN_MEMORY_BYTES && !this.supportsFileSystemAccess() && !hasOPFS) {
      throw new Error(
        `File is ${(contentLength / 1024 / 1024).toFixed(0)}MB — too large for safe in-memory download. ` +
        `Enable "Direct browser download" in settings to use Chrome's native downloader instead.`
      );
    }

    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
    const totalChunks = Math.ceil(contentLength / CHUNK_SIZE);
    
    const tempFileName = `temp_direct_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.tmp`;
    const diskBuffer = new DiskBuffer(tempFileName);
    await diskBuffer.init();
    
    this.downloadedBytes = 0;
    this.completedChunksCount = 0;
    this.downloadStartTime = Date.now();
    this.concurrencyLimit = 3;

    const queue = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1);
      queue.push({ index: i, start, end });
    }

    let activeWorkers = 0;
    const downloadWorker = async () => {
      activeWorkers++;
      while (queue.length > 0 && !this.cancelled) {
        if (activeWorkers > this.concurrencyLimit) {
          activeWorkers--;
          return;
        }

        const item = queue.shift();
        if (!item) break;

        try {
          const buffer = await this.fetchChunkWithRetry(url, item.start, item.end, 3);
          
          await diskBuffer.write(buffer, item.start);
          this.downloadedBytes += buffer.byteLength;
          this.completedChunksCount++;
          
          const percentage = Math.round((this.downloadedBytes / contentLength) * 100);
          this.onProgress({ percentage, downloadedBytes: this.downloadedBytes, totalBytes: contentLength });
          
          // Adaptive concurrency evaluation
          if (this.completedChunksCount >= 2) {
            const elapsedSec = (Date.now() - this.downloadStartTime) / 1000;
            const speed = this.downloadedBytes / (elapsedSec || 1);
            
            const prevLimit = this.concurrencyLimit;
            if (speed > 8 * 1024 * 1024) { // > 8MB/s
              this.concurrencyLimit = 5;
            } else if (speed < 500 * 1024) { // < 500KB/s
              this.concurrencyLimit = 1;
            } else {
              this.concurrencyLimit = 3;
            }

            if (this.concurrencyLimit > prevLimit) {
              while (activeWorkers < this.concurrencyLimit && queue.length > 0) {
                downloadWorker();
              }
            }
          }
        } catch (e) {
          if (this.cancelled) {
            activeWorkers--;
            return;
          }
          console.error(`[DirectMediaDownloader] Chunk ${item.index} failed:`, e);
          activeWorkers--;
          throw new Error(`Failed downloading chunk ${item.index}: ${e.message}`);
        }
      }
      activeWorkers--;
    };

    const initialWorkers = Math.min(this.concurrencyLimit, totalChunks);
    const workers = [];
    for (let w = 0; w < initialWorkers; w++) {
      workers.push(downloadWorker());
    }

    await Promise.all(workers);

    if (this.cancelled) {
      await diskBuffer.cleanup();
      throw new Error("Download aborted.");
    }

    const blob = await diskBuffer.closeAndGetBlob(this.mimeType || "video/mp4");
    setTimeout(() => {
      diskBuffer.cleanup();
    }, 15000);
    
    return blob;
  }

  async fetchChunkWithRetry(url, start, end, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.fetchArrayBuffer(url, start, end);
      } catch (err) {
        if (this.cancelled) throw err;
        if (attempt === retries) throw err;

        // Exponential backoff with jitter (Optimization 8)
        const delay = 300 * Math.pow(2, attempt) + Math.random() * 150;
        console.warn(`[DirectMediaDownloader] Chunk fetch failed, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${retries}). Range: ${start}-${end}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async downloadAsStream(url, contentLength) {
    if (this.tabId) {
      const res = await this.fetchWithProxy(url, {
        signal: this.abortController.signal
      }, "arraybuffer");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      this.onProgress({ percentage: 100, downloadedBytes: blob.size, totalBytes: blob.size });
      return blob;
    }

    const res = await fetch(url, {
      signal: this.abortController.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const tempFileName = `temp_direct_stream_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.tmp`;
    const diskBuffer = new DiskBuffer(tempFileName);
    await diskBuffer.init();
    
    this.downloadedBytes = 0;
    const totalBytes = contentLength || parseInt(res.headers.get("Content-Length") || "0", 10);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      await diskBuffer.write(value);
      this.downloadedBytes += value.length;

      const percentage = totalBytes > 0 ? Math.round((this.downloadedBytes / totalBytes) * 100) : 0;
      this.onProgress({ percentage, downloadedBytes: this.downloadedBytes, totalBytes: totalBytes || null });
    }

    if (this.cancelled) {
      await diskBuffer.cleanup();
      throw new Error("Download aborted.");
    }

    const blob = await diskBuffer.closeAndGetBlob(this.mimeType || "video/mp4");
    setTimeout(() => {
      diskBuffer.cleanup();
    }, 15000);
    return blob;
  }
}
