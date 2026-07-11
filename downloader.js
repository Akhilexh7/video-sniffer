// downloader.js
// Gateway module that exports all downloaders from modular files

export { HlsDownloader } from './downloaders/hlsDownloader.js';
export { DirectMediaMerger } from './downloaders/directMediaMerger.js';
export { DirectMediaDownloader } from './downloaders/directDownloader.js';
export { YoutubeDownloader } from './downloaders/youtubeDownloader.js';