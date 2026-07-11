// downloaders/youtubeDownloader.js

import { DirectMediaDownloader } from './directDownloader.js';
import { remuxMp4AndM4a } from '../mux/mp4-muxer.js';

export class YoutubeDownloader {
  constructor(videoUrl, audioUrl, onProgress, tabId = null, frameId = null) {
    this.videoUrl = videoUrl;
    this.audioUrl = audioUrl;
    this.onProgress = onProgress || (() => {});
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
    let videoProgress = 0;
    let audioProgress = 0;
    let videoBytes = 0;
    let audioBytes = 0;
    let videoTotalBytes = 0;
    let audioTotalBytes = 0;

    const updateProgress = () => {
      const totalBytes = videoBytes + audioBytes;
      const totalExpectedBytes = videoTotalBytes + audioTotalBytes;
      const percentage = Math.round((videoProgress + audioProgress) / 2);
      this.onProgress({ 
        percentage, 
        downloadedBytes: totalBytes, 
        totalBytes: totalExpectedBytes > 0 ? totalExpectedBytes : null 
      });
    };

    this.videoDownloader = new DirectMediaDownloader(this.videoUrl, (p) => {
      videoProgress = p.percentage;
      videoBytes = p.downloadedBytes;
      if (p.totalBytes) videoTotalBytes = p.totalBytes;
      updateProgress();
    }, this.tabId, this.frameId);

    this.audioDownloader = new DirectMediaDownloader(this.audioUrl, (p) => {
      audioProgress = p.percentage;
      audioBytes = p.downloadedBytes;
      if (p.totalBytes) audioTotalBytes = p.totalBytes;
      updateProgress();
    }, this.tabId, this.frameId);

    console.log("[YoutubeDownloader] Starting parallel downloads of video and audio...");
    const [videoResult, audioResult] = await Promise.all([
      this.videoDownloader.start(),
      this.audioDownloader.start()
    ]);

    if (this.cancelled) {
      throw new Error("Download aborted.");
    }

    console.log("[YoutubeDownloader] Streams downloaded. Getting array buffers...");
    const videoBuffer = await videoResult.blob.arrayBuffer();
    const audioBuffer = await audioResult.blob.arrayBuffer();

    console.log("[YoutubeDownloader] Muxing video and audio tracks...");
    const mergedBlob = remuxMp4AndM4a(videoBuffer, audioBuffer);
    
    return {
      blob: mergedBlob,
      extension: "mp4",
      mimeType: "video/mp4"
    };
  }
}
