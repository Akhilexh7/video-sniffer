(function() {
  if (window.__youtube_sniffer_injected__) return;
  window.__youtube_sniffer_injected__ = true;

  console.log("[YouTube Sniffer] Simplified main world script initialized.");

  let lastVideoId = null;

  function checkPlayer() {
    try {
      let response = null;
      if (window.ytInitialPlayerResponse) {
        response = window.ytInitialPlayerResponse;
      } else {
        const player = document.getElementById("movie_player");
        if (player && typeof player.getPlayerResponse === "function") {
          response = player.getPlayerResponse();
        }
      }

      if (!response || !response.videoDetails) return;

      const videoId = response.videoDetails.videoId;
      if (videoId && videoId !== lastVideoId) {
        lastVideoId = videoId;
        console.log("[YouTube Sniffer] New video ID detected:", videoId);
        
        // Post a simplified response back to content.js
        window.postMessage({
          type: "YOUTUBE_PLAYER_RESPONSE",
          response: {
            videoDetails: {
              videoId: videoId,
              title: response.videoDetails.title,
              thumbnail: response.videoDetails.thumbnail
            },
            streamingData: {
              // progressive formats only (if available)
              formats: response.streamingData ? (response.streamingData.formats || []) : []
            }
          },
          title: document.title
        }, "*");
      }
    } catch (e) {
      console.warn("[YouTube Sniffer] Error checking player:", e);
    }
  }

  // Check periodically (every 3 seconds), performing no heavy copy or fetch operations
  setInterval(checkPlayer, 3000);
  
  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(checkPlayer, 500);
  });
})();
