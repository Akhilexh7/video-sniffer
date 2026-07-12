// Redirect console.log to console.error (stderr) if running in a non-interactive shell (Chrome Native Messaging)
// to prevent raw text from polluting stdout and crashing Chrome's parser.
if (!process.stdin.isTTY) {
    console.log = console.error;
}

const express = require('express');
const cors = require('cors');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the output folder so the extension can download/fetch the finished files
const outputDir = path.join(__dirname, 'output');
app.use('/stream', express.static(outputDir));

// Ensure directories exist
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

const binDir = path.join(__dirname, 'bin');
if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
}

const localYtdlpPath = path.join(binDir, 'yt-dlp.exe');
let ytdlpExecutable = 'yt-dlp'; // fallback to system command

// Function to check if local yt-dlp exists, and download if it doesn't
function ensureYtdlp() {
    return new Promise((resolve, reject) => {
        // If it already exists, resolve immediately
        if (fs.existsSync(localYtdlpPath)) {
            ytdlpExecutable = localYtdlpPath;
            return resolve(localYtdlpPath);
        }

        console.log(`[Backend] Local yt-dlp binary not found. Downloading latest yt-dlp.exe from GitHub...`);
        const file = fs.createWriteStream(localYtdlpPath);
        
        const download = (url) => {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    download(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download yt-dlp: HTTP status ${response.statusCode}`));
                    return;
                }
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log(`[Backend] yt-dlp.exe downloaded successfully to ${localYtdlpPath}`);
                    ytdlpExecutable = localYtdlpPath;
                    resolve(localYtdlpPath);
                });
            }).on('error', (err) => {
                fs.unlink(localYtdlpPath, () => {}); // Delete temp file
                reject(err);
            });
        };

        // Download the latest Windows binary
        download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    });
}

// Global object to track download progress
const downloadProgress = {};

// GET /api/progress/:fileName
app.get('/api/progress/:fileName', (req, res) => {
    const fileName = req.params.fileName;
    const progress = downloadProgress[fileName];
    if (!progress) {
        res.json({ progress: 0, percentage: 0, downloadedBytes: 0, totalBytes: null });
    } else if (typeof progress === 'number') {
        res.json({ progress: progress, percentage: progress, downloadedBytes: 0, totalBytes: null });
    } else {
        res.json(progress);
    }
});

// GET /api/youtube-formats
app.get('/api/youtube-formats', (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    console.log(`[Backend] Fetching available formats for: ${url}`);
    
    execFile(ytdlpExecutable, ['--dump-json', '--no-playlist', url], (error, stdout, stderr) => {
        if (error) {
            console.error(`[Backend] Failed to fetch formats:`, stderr || error.message);
            return res.status(500).json({ error: 'Failed to fetch video formats' });
        }
        
        try {
            const data = JSON.parse(stdout);
            const formats = data.formats || [];
            
            const resolutionsSet = new Set();
            formats.forEach(f => {
                if (f.vcodec !== 'none' && f.height) {
                    resolutionsSet.add(f.height);
                }
            });
            
            const sortedHeights = Array.from(resolutionsSet).sort((a, b) => b - a);
            const availableQualities = sortedHeights.map(h => {
                let label = `${h}p`;
                if (h >= 2160) label += ' (4K)';
                else if (h >= 1440) label += ' (2K)';
                else if (h >= 1080) label += ' (FHD)';
                else if (h >= 720) label += ' (HD)';
                
                return {
                    resolution: `${h}p`,
                    label: label
                };
            });
            
            // Add a "Best Quality" option too
            availableQualities.unshift({
                resolution: 'Best',
                label: 'Best Quality (Auto)'
            });
            
            res.json({ qualities: availableQualities });
        } catch (e) {
            console.error(`[Backend] Failed to parse JSON formats:`, e);
            res.status(500).json({ error: 'Failed to parse format data' });
        }
    });
});

// GET /api/ping
app.get('/api/ping', (req, res) => {
    res.json({ pong: true });
});

// POST /api/download-youtube-video
app.post('/api/download-youtube-video', (req, res) => {
    const { url, title, resolution } = req.body;
    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    console.log(`[Backend] Request received to download YouTube video: ${url} at resolution: ${resolution || 'best'}`);

    const videoTitle = title || `youtube_${Date.now()}`;
    const cleanTitle = videoTitle.replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, '_').toLowerCase();
    
    // Add resolution suffix to the filename if specified
    const resSuffix = resolution ? `_${resolution.replace(/[^a-z0-9]/gi, '')}` : '';
    const fileName = `${cleanTitle}${resSuffix}.mp4`;
    const outputPath = path.join(outputDir, fileName);

    const streamUrl = `/stream/${encodeURIComponent(fileName)}`;

    if (fs.existsSync(outputPath)) {
        console.log(`[Backend] Video already exists, skipping download: ${fileName}`);
        downloadProgress[fileName] = 100;
        return res.json({ 
            success: true, 
            message: `Video already downloaded.`,
            streamUrl: streamUrl,
            fileName: fileName,
            alreadyDownloaded: true
        });
    }

    // Format query:
    // 1. Try to download best video <= height and best audio (requires ffmpeg)
    // 2. Fall back to best progressive format <= height (does NOT require ffmpeg!)
    // 3. Fall back to best progressive format overall (does NOT require ffmpeg!)
    let formatArg = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
    if (resolution) {
        const heightMatch = resolution.match(/(\d+)/);
        if (heightMatch) {
            const height = heightMatch[1];
            formatArg = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
        }
    }

    const ffmpegPath = require('ffmpeg-static');

    const ytdlpArgs = [
        url,
        '--no-playlist',
        '--no-warnings',
        '--format', formatArg,
        '--merge-output-format', 'mp4',
        '--output', fileName,
    ];

    if (ffmpegPath) {
        console.log(`[Backend] Found static ffmpeg binary: ${ffmpegPath}`);
        ytdlpArgs.push('--ffmpeg-location', ffmpegPath);
    }

    console.log(`[Backend] Spawning yt-dlp for video: ${url} with formats: ${formatArg} (cwd: ${outputDir})`);
    console.log(`[Backend] Using executable: ${ytdlpExecutable}`);
    
    const child = spawn(ytdlpExecutable, ytdlpArgs, { shell: false, cwd: outputDir });

    downloadProgress[fileName] = 1;

    child.on('error', (err) => {
        console.error(`[Backend] Failed to start yt-dlp process:`, err);
        downloadProgress[fileName] = -1;
    });

    child.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[yt-dlp stdout] ${output.trim()}`);
        
        // Track merger/muxing state
        if (output.includes('[Merger]') || output.includes('Merging formats')) {
            const current = downloadProgress[fileName] || {};
            downloadProgress[fileName] = {
                progress: 99,
                percentage: 99,
                downloadedBytes: current.totalBytes || 0,
                totalBytes: current.totalBytes || null,
                status: 'muxing'
            };
            return;
        }

        // Match percentage and total size
        // Example: "[download]  28.5% of   34.11MiB"
        const match = output.match(/(\d+(?:\.\d+)?)%\s*of\s*(\d+(?:\.\d+)?)(\w+)/);
        if (match) {
            let percentage = parseFloat(match[1]);
            if (percentage >= 100) percentage = 99;
            const sizeVal = parseFloat(match[2]);
            const unit = match[3].toLowerCase(); // e.g. "mib", "kib"
            
            // Convert to bytes
            let multiplier = 1;
            if (unit.startsWith('g')) multiplier = 1024 * 1024 * 1024;
            else if (unit.startsWith('m')) multiplier = 1024 * 1024;
            else if (unit.startsWith('k')) multiplier = 1024;
            
            const totalBytes = Math.round(sizeVal * multiplier);
            const downloadedBytes = Math.round((percentage / 100) * totalBytes);
            
            downloadProgress[fileName] = {
                progress: percentage,
                percentage: percentage,
                downloadedBytes: downloadedBytes,
                totalBytes: totalBytes,
                status: 'downloading'
            };
        } else {
            // Fallback for simple percentage
            const simpleMatch = output.match(/(\d+(?:\.\d+)?)%/);
            if (simpleMatch) {
                let percentage = parseFloat(simpleMatch[1]);
                if (percentage >= 100) percentage = 99;
                const current = downloadProgress[fileName] || {};
                downloadProgress[fileName] = {
                    progress: percentage,
                    percentage: percentage,
                    downloadedBytes: current.downloadedBytes || 0,
                    totalBytes: current.totalBytes || null,
                    status: 'downloading'
                };
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`[yt-dlp stderr] ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
        if (code === 0) {
            console.log(`\n[Backend] Video download SUCCEEDED: ${fileName}`);
            downloadProgress[fileName] = 100;
            setTimeout(() => delete downloadProgress[fileName], 60000);
        } else {
            console.error(`\n[Backend] Video download FAILED with code ${code}`);
            downloadProgress[fileName] = -1;
        }
    });

    console.log(`[Backend] Returning stream URL for video: ${streamUrl}`);

    res.json({ 
        success: true, 
        message: `Download started`,
        streamUrl: streamUrl,
        fileName: fileName,
        alreadyDownloaded: false
    });
});

// Initialize yt-dlp then start server
ensureYtdlp()
    .then((binPath) => {
        app.listen(PORT, () => {
            console.log(`Local YouTube Downloader Backend running on port ${PORT}`);
            console.log(`Ready and using local yt-dlp at: ${binPath}`);
        });
    })
    .catch((err) => {
        console.error(`[Backend] Failed to auto-download yt-dlp:`, err.message);
        console.log(`[Backend] Falling back to system PATH command 'yt-dlp'.`);
        app.listen(PORT, () => {
            console.log(`Local YouTube Downloader Backend running on port ${PORT} (using system 'yt-dlp')`);
        });
    });

// Native Messaging Host handler: keep process alive and exit when stdin closes.
// This allows Chrome to automatically kill the server when the extension disconnects.
process.stdin.on('end', () => {
    console.log('[Backend] Native connection closed by Chrome. Exiting...');
    process.exit(0);
});

process.stdin.on('close', () => {
    console.log('[Backend] Native stdin closed. Exiting...');
    process.exit(0);
});

// Resume stdin so it doesn't exit prematurely when stdin is piped
process.stdin.resume();
