// downloaders/spotifyDownloader.js

export class SpotifyDownloader {
  constructor(spotifyUrl, onProgress, pageTitle = null, quality = "best") {
    this.spotifyUrl = spotifyUrl;
    this.onProgress = onProgress || (() => {});
    this.pageTitle = pageTitle;
    this.quality = quality;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  async start() {
    console.log(`[SpotifyDownloader] Attempting to download via local backend: ${this.spotifyUrl} with quality: ${this.quality}`);
    
    const response = await fetch('http://localhost:3000/api/download-spotify-track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: this.spotifyUrl,
        title: this.pageTitle,
        quality: this.quality
      })
    });

    if (!response.ok) {
      throw new Error(`Local backend download failed: ${response.statusText}. Please ensure your local backend server is running.`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(`Failed to start Spotify download: ${data.error || 'unknown error'}`);
    }

    console.log(`[SpotifyDownloader] Backend download started:`, data);
    
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
        
        let statusText = 'Downloading audio stream...';
        if (progData.status === 'converting') {
          statusText = 'Converting audio format...';
        }

        this.onProgress({
          percentage: Math.round(progressVal),
          downloadedBytes: progData.downloadedBytes || 0,
          totalBytes: progData.totalBytes || null,
          status: progData.status || null,
          statusText: statusText
        });

        if (progressVal >= 100) {
          finished = true;
          break;
        }
      }
      
      // Wait 1 second before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`[SpotifyDownloader] Backend download completed. Fetching file from backend: ${finalStreamUrl}`);
    
    // Fetch the completed file from the backend server
    const fileResponse = await fetch(finalStreamUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to fetch completed audio from backend: ${fileResponse.statusText}`);
    }

    const audioBlob = await fileResponse.blob();
    const ext = this.quality === '256k' ? 'm4a' : 'mp3';
    const mimeType = this.quality === '256k' ? 'audio/mp4' : 'audio/mpeg';

    return {
      blob: audioBlob,
      extension: ext,
      mimeType: mimeType
    };
  }
}
