// downloaders/directMediaMerger.js

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
