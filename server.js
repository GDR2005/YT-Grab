const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const YTDLP_PATH = path.join(__dirname, 'yt-dlp.exe');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR);

const ytDlp = new YTDlpWrap(YTDLP_PATH);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/downloads', express.static(DOWNLOADS_DIR));

app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const info = await ytDlp.getVideoInfo(url);

    const seen = new Set();
    const videoFormats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .filter(f => {
        const key = `${f.height}p`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(f => ({
        quality: `${f.height}p`,
        itag: f.format_id,
        container: f.ext,
        filesize: f.filesize ? Math.round(f.filesize / 1024 / 1024) + ' MB' : '?',
      }));

    const seenA = new Set();
    const audioFormats = (info.formats || [])
      .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.abr)
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))
      .filter(f => {
        const key = `${Math.round(f.abr)}k`;
        if (seenA.has(key)) return false;
        seenA.add(key);
        return true;
      })
      .map(f => ({
        bitrate: `${Math.round(f.abr)}kbps`,
        itag: f.format_id,
        container: f.ext,
      }));

    res.json({
      title: info.title,
      duration: formatDuration(info.duration),
      views: info.view_count ? Number(info.view_count).toLocaleString() + ' views' : '',
      thumbnail: info.thumbnail,
      channel: info.uploader,
      videoFormats,
      audioFormats,
    });
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: 'Could not fetch video info: ' + err.message });
  }
});

app.get('/api/download/video', async (req, res) => {
  const { url, quality = 'bestvideo+bestaudio', format = 'mp4' } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const info = await ytDlp.getVideoInfo(url);
    const title = sanitizeFilename(info.title);
    const filename = `${title}.${format}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    const stream = ytDlp.execStream([
      url,
      '-f', quality,
      '--merge-output-format', format,
      '-o', '-',
    ]);

    stream.on('error', err => {
      console.error('Video stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download/audio', async (req, res) => {
  const { url, format = 'mp3' } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  try {
    const info = await ytDlp.getVideoInfo(url);
    const title = sanitizeFilename(info.title);
    const filename = `${title}.${format}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');

    const stream = ytDlp.execStream([
      url,
      '-f', 'bestaudio',
      '--extract-audio',
      '--audio-format', format,
      '-o', '-',
    ]);

    stream.on('error', err => {
      console.error('Audio stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    stream.pipe(res);
  } catch (err) {
    console.error('Audio download error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/progress', (req, res) => {
  const { url, type = 'video' } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ status: 'starting', progress: 0 });

  const proc = ytDlp.exec([url, '--no-download', '--newline', '-o', 'NULL']);

  proc.on('ytDlpEvent', (event, data) => {
    const match = data.match(/([\d.]+)%/);
    if (match) {
      const pct = Math.round(parseFloat(match[1]));
      send({ status: 'downloading', progress: pct });
    }
  });

  proc.on('close', () => {
    send({ status: 'done', progress: 100 });
    res.end();
  });

  proc.on('error', err => {
    send({ status: 'error', message: err.message });
    res.end();
  });

  req.on('close', () => proc.kill());
});

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 100);
}

function formatDuration(seconds) {
  if (!seconds) return '–';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`\n🎬 YTgrab running → http://localhost:${PORT}\n`);
});