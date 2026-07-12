// downloaders/youtubeDownloader.js

import { DirectMediaDownloader } from './directDownloader.js';
import { remuxMp4AndM4a } from '../mux/mp4-muxer.js';

export class YoutubeDownloader {
  constructor(videoUrl, audioUrl, onProgress, tabId = null, frameId = null, youtubeUrl = null, resolution = null) {
    this.videoUrl = videoUrl;
    this.audioUrl = audioUrl;
    this.onProgress = onProgress || (() => {});
    this.tabId = tabId;
    this.frameId = frameId;
    this.youtubeUrl = youtubeUrl;
    this.resolution = resolution;
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
    if (this.youtubeUrl) {
      console.log(`[YoutubeDownloader] Attempting to download via local backend yt-dlp: ${this.youtubeUrl} with quality resolution: ${this.resolution}`);
      try {
        const response = await fetch('http://localhost:3000/api/download-youtube-video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            url: this.youtubeUrl,
            title: `youtube_${Date.now()}`,
            resolution: this.resolution
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            console.log(`[YoutubeDownloader] Backend download started:`, data);
            
            // Poll progress
            let finished = false;
            let finalStreamUrl = `http://localhost:3000${data.streamUrl}`;
            
            while (!finished) {
              if (this.cancelled) {
                throw new Error("Download aborted.");
              }
              
              // Poll progress endpoint
              const progRes = await fetch(`http://localhost:3000/api/progress/${encodeURIComponent(data.fileName)}`);
              if (progRes.ok) {
                const progData = await progRes.json();
                const progressVal = typeof progData === 'object' && progData.hasOwnProperty('percentage')
                  ? progData.percentage
                  : (progData.progress || 0);
                
                if (progressVal < 0) {
                  throw new Error("yt-dlp download failed on local server. Ensure yt-dlp is installed and in your PATH.");
                }
                
                this.onProgress({
                  percentage: Math.round(progressVal),
                  downloadedBytes: progData.downloadedBytes || 0,
                  totalBytes: progData.totalBytes || null,
                  status: progData.status || null,
                  statusText: progData.status === 'muxing' ? 'Muxing audio and video...' : 'Downloading video streams...'
                });

                if (progressVal >= 100) {
                  finished = true;
                  break;
                }
              }
              
              // Wait 1 second before polling again
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log(`[YoutubeDownloader] Backend download completed. Fetching file from backend: ${finalStreamUrl}`);
            
            // Fetch the completed file from the backend server
            const fileResponse = await fetch(finalStreamUrl);
            if (!fileResponse.ok) {
              throw new Error(`Failed to fetch completed video from backend: ${fileResponse.statusText}`);
            }

            const videoBlob = await fileResponse.blob();
            return {
              blob: videoBlob,
              extension: "mp4",
              mimeType: "video/mp4"
            };
          }
        }
      } catch (err) {
        console.warn(`[YoutubeDownloader] Backend download failed or server is offline. Error:`, err);
        if (!this.videoUrl || !this.audioUrl) {
          throw new Error(`Local backend download failed: ${err.message || err}. Please ensure your local backend server is running (npm start in extension/backend) and yt-dlp is installed.`);
        }
      }
    }

    // Fallback: Browser-based download
    console.log(`[YoutubeDownloader] Using browser-based fallback download...`);
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
