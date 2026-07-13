// downloaders/diskBuffer.js

async function logDiag(msg) {
  console.log(msg);
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const data = await chrome.storage.local.get("disk_buffer_logs");
      const logs = data.disk_buffer_logs || [];
      logs.push(`${new Date().toISOString()} - ${msg}`);
      await chrome.storage.local.set({ disk_buffer_logs: logs.slice(-150) });
    } catch (e) {}
  }
}

export class DiskBuffer {
  constructor(filename) {
    this.filename = filename;
    this.fileHandle = null;
    this.writable = null;
    this.inMemoryBuffer = [];
    this.isDisk = false;
  }

  async init() {
    try {
      if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        try {
          await root.removeEntry(this.filename);
        } catch(e) {}
        this.fileHandle = await root.getFileHandle(this.filename, { create: true });
        this.writable = await this.fileHandle.createWritable();
        this.isDisk = true;
        await logDiag(`[DiskBuffer] Initialized OPFS disk buffer for ${this.filename}`);
      } else {
        await logDiag(`[DiskBuffer] OPFS not supported, using in-memory fallback`);
      }
    } catch (e) {
      await logDiag(`[DiskBuffer] Failed to initialize OPFS: ${e.message}. Stack: ${e.stack}`);
      this.isDisk = false;
    }
  }

  async write(chunk, position = null) {
    const chunkSize = chunk ? (chunk.byteLength || chunk.length || 0) : 0;
    if (this.isDisk) {
      try {
        if (position !== null) {
          await logDiag(`[DiskBuffer] Seeking to position ${position} and writing chunk size ${chunkSize} to disk`);
          await this.writable.seek(position);
          await this.writable.write(chunk);
        } else {
          await logDiag(`[DiskBuffer] Writing chunk size ${chunkSize} sequentially to disk`);
          await this.writable.write(chunk);
        }
      } catch (e) {
        await logDiag(`[DiskBuffer] Failed to write chunk to disk, falling back to memory addition. Error: ${e.message}`);
        this.isDisk = false;
        if (position !== null) {
          this.inMemoryBuffer.push({ position, data: chunk });
        } else {
          this.inMemoryBuffer.push(chunk);
        }
      }
    } else {
      await logDiag(`[DiskBuffer] Writing chunk size ${chunkSize} to memory buffer`);
      if (position !== null) {
        this.inMemoryBuffer.push({ position, data: chunk });
      } else {
        this.inMemoryBuffer.push(chunk);
      }
    }
  }

  async closeAndGetBlob(type = "video/mp4") {
    if (this.isDisk) {
      try {
        await logDiag(`[DiskBuffer] Closing writable stream...`);
        await this.writable.close();
        await logDiag(`[DiskBuffer] Writable closed. Retrieving file...`);
        const file = await this.fileHandle.getFile();
        await logDiag(`[DiskBuffer] Retrieved file. Size: ${file.size} bytes`);
        return file;
      } catch (e) {
        await logDiag(`[DiskBuffer] Failed to close or get file: ${e.message}. Falling back to in-memory (size: ${this.inMemoryBuffer.length})`);
        return new Blob(this.inMemoryBuffer, { type });
      }
    } else {
      await logDiag(`[DiskBuffer] Closing in-memory buffer. Count: ${this.inMemoryBuffer.length}`);
      if (this.inMemoryBuffer.length > 0 && typeof this.inMemoryBuffer[0].position === "number") {
        this.inMemoryBuffer.sort((a, b) => a.position - b.position);
        const mapped = this.inMemoryBuffer.map(item => item.data);
        const blob = new Blob(mapped, { type });
        await logDiag(`[DiskBuffer] Returned sorted in-memory blob. Size: ${blob.size} bytes`);
        return blob;
      }
      const blob = new Blob(this.inMemoryBuffer, { type });
      await logDiag(`[DiskBuffer] Returned sequential in-memory blob. Size: ${blob.size} bytes`);
      return blob;
    }
  }

  async cleanup() {
    if (this.isDisk) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.filename);
        await logDiag(`[DiskBuffer] Cleaned up OPFS file ${this.filename}`);
      } catch (e) {
        await logDiag(`[DiskBuffer] Cleanup failed: ${e.message}`);
      }
    }
  }
}
