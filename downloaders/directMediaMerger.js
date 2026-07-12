// downloaders/directMediaMerger.js

import { remuxMp4AndM4a } from '../mux/mp4-muxer.js';
import { DirectMediaDownloader } from './directDownloader.js';

export class DirectMediaMerger {
  constructor(videoUrl, audioUrl, onProgress = null, tabId = null, frameId = null) {
    this.videoUrl = videoUrl;
    this.audioUrl = audioUrl;
    this.onProgress = onProgress;
    this.tabId = tabId;
    this.frameId = frameId;
    this.cancelled = false;
    this.videoDownloader = null;
    this.audioDownloader = null;
  }

  cancel() {
    this.cancelled = true;
    if (this.videoDownloader) this.videoDownloader.cancel();
    if (this.audioDownloader) this.audioDownloader.cancel();
  }

  async start() {
    if (!this.videoUrl || !this.audioUrl) {
      throw new Error("Both video and audio URLs are required for media merging.");
    }

    let videoProgress = 0;
    let audioProgress = 0;
    let videoBytes = 0;
    let audioBytes = 0;
    let videoTotalBytes = 0;
    let audioTotalBytes = 0;

    const updateProgress = () => {
      if (!this.onProgress) return;
      const totalBytes = videoBytes + audioBytes;
      const totalExpectedBytes = videoTotalBytes + audioTotalBytes;
      const percentage = Math.round((videoProgress + audioProgress) / 2);
      this.onProgress({
        percentage,
        downloadedBytes: totalBytes,
        totalBytes: totalExpectedBytes > 0 ? totalExpectedBytes : null
      });
    };

    console.log("[DirectMediaMerger] Downloading video track in parallel...");
    this.videoDownloader = new DirectMediaDownloader(this.videoUrl, (p) => {
      videoProgress = p.percentage;
      videoBytes = p.downloadedBytes;
      if (p.totalBytes) videoTotalBytes = p.totalBytes;
      updateProgress();
    }, this.tabId, this.frameId);

    console.log("[DirectMediaMerger] Downloading audio track in parallel...");
    this.audioDownloader = new DirectMediaDownloader(this.audioUrl, (p) => {
      audioProgress = p.percentage;
      audioBytes = p.downloadedBytes;
      if (p.totalBytes) audioTotalBytes = p.totalBytes;
      updateProgress();
    }, this.tabId, this.frameId);

    const [videoData, audioData] = await Promise.all([
      this.videoDownloader.start(),
      this.audioDownloader.start()
    ]);

    if (this.cancelled) {
      throw new Error("Download aborted.");
    }

    console.log("[DirectMediaMerger] Remuxing video and audio tracks...");
    const videoBuffer = await videoData.blob.arrayBuffer();
    const audioBuffer = await audioData.blob.arrayBuffer();

    const outputBuffer = remuxMp4AndM4a(videoBuffer, audioBuffer);
    const blob = new Blob([outputBuffer], { type: "video/mp4" });

    return {
      blob,
      extension: "mp4",
      mimeType: "video/mp4"
    };
  }
}
