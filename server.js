const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));

const TMP = '/tmp/biblical';
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

// Health check
app.get('/', (req, res) => res.json({ status: 'Biblical Video Renderer running' }));

// Download a file from URL
async function download(url, dest) {
  const res = await axios({ url, responseType: 'arraybuffer', timeout: 60000 });
  fs.writeFileSync(dest, res.data);
}

// Escape text for FFmpeg drawtext filter
function escapeText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\u2019")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

// Build SRT file from subtitles array
function buildSRT(subtitles) {
  return subtitles.map((s, i) => {
    const fmt = (t) => {
      const h = Math.floor(t / 3600).toString().padStart(2, '0');
      const m = Math.floor((t % 3600) / 60).toString().padStart(2, '0');
      const sec = Math.floor(t % 60).toString().padStart(2, '0');
      return `${h}:${m}:${sec},000`;
    };
    return `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}`;
  }).join('\n\n');
}

// Main render endpoint
app.post('/render', async (req, res) => {
  const jobId = Date.now();
  const jobDir = path.join(TMP, String(jobId));
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      imageUrl,
      audioUrl,
      subtitles = [],
      overlayText = '',
      duration = 20,
      overlayColor = '#FFFFFF',
      accentColor = '#FF4444'
    } = req.body;

    if (!imageUrl || !audioUrl) {
      return res.status(400).json({ error: 'imageUrl and audioUrl are required' });
    }

    console.log(`[${jobId}] Starting render: ${duration}s`);

    // 1. Download assets
    const imgPath = path.join(jobDir, 'image.png');
    const audioPath = path.join(jobDir, 'audio.mp3');
    const srtPath = path.join(jobDir, 'subs.srt');
    const outputPath = path.join(jobDir, 'output.mp4');

    await download(imageUrl, imgPath);
    await download(audioUrl, audioPath);

    // 2. Write SRT
    if (subtitles.length > 0) {
      fs.writeFileSync(srtPath, buildSRT(subtitles));
    }

    // 3. Build FFmpeg command
    // Ken Burns effect: slow zoom from 100% to 110% over the duration
   const zoompan = `scale=1920:1080`;

    // Overlay text (bold, left side, ~40% width)
    const escapedText = escapeText(overlayText);
    const textFilter = overlayText
      ? `,drawtext=text='${escapedText}':fontsize=58:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=60:y=(h-text_h)/2:line_spacing=20:borderw=3:bordercolor=black@0.8:box=0:shadowx=3:shadowy=3`
      : '';

    // Subtitles filter
    const subsFilter = subtitles.length > 0
      ? `,subtitles=${srtPath}:force_style='FontSize=42,FontName=DejaVu Sans Bold,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=50'`
      : '';

    const vf = `${zoompan}${textFilter}${subsFilter}`;

    const ffmpegCmd = [
      'ffmpeg -y',
      `-loop 1 -i "${imgPath}"`,
      `-i "${audioPath}"`,
      `-vf "${vf}"`,
      `-t ${duration}`,
      '-c:v libx264 -preset fast -crf 23',
      '-c:a aac -b:a 192k',
      '-pix_fmt yuv420p',
      `-shortest "${outputPath}"`
    ].join(' ');

    console.log(`[${jobId}] Running FFmpeg...`);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[${jobId}] FFmpeg error:`, stderr.slice(-500));
          reject(new Error(stderr.slice(-300)));
        } else {
          resolve();
        }
      });
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Output file was not created');
    }

    const stats = fs.statSync(outputPath);
    console.log(`[${jobId}] Done! Size: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);

    // 4. Stream video back
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="biblical_video_${jobId}.mp4"`);
    res.setHeader('Content-Length', stats.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      // Cleanup
      setTimeout(() => {
        try { fs.rmSync(jobDir, { recursive: true }); } catch (e) {}
      }, 5000);
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    try { fs.rmSync(jobDir, { recursive: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// Multi-image render (for longer videos)
app.post('/render-multi', async (req, res) => {
  const jobId = Date.now();
  const jobDir = path.join(TMP, String(jobId));
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const {
      segments,    // [{imageUrl, overlayText, startTime, endTime}]
      audioUrl,
      subtitles = [],
      totalDuration
    } = req.body;

    if (!segments || !audioUrl) {
      return res.status(400).json({ error: 'segments and audioUrl are required' });
    }

    console.log(`[${jobId}] Multi-image render: ${segments.length} segments, ${totalDuration}s`);

    const audioPath = path.join(jobDir, 'audio.mp3');
    const srtPath = path.join(jobDir, 'subs.srt');
    const outputPath = path.join(jobDir, 'output.mp4');
    const concatFile = path.join(jobDir, 'concat.txt');

    await download(audioUrl, audioPath);
    if (subtitles.length > 0) fs.writeFileSync(srtPath, buildSRT(subtitles));

    // Download all images and render each segment
    const segmentFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const imgPath = path.join(jobDir, `img_${i}.png`);
      const segPath = path.join(jobDir, `seg_${i}.mp4`);
      const segDuration = seg.endTime - seg.startTime;

      await download(seg.imageUrl, imgPath);

      const escapedText = escapeText(seg.overlayText || '');
      const textFilter = seg.overlayText
        ? `,drawtext=text='${escapedText}':fontsize=58:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=60:y=(h-text_h)/2:line_spacing=20:borderw=3:bordercolor=black@0.8:shadowx=3:shadowy=3`
        : '';

      const zoompan = `scale=8000:-1,zoompan=z='min(zoom+0.0008,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(segDuration * 25)}:s=1920x1080:fps=25`;

      const cmd = [
        'ffmpeg -y',
        `-loop 1 -i "${imgPath}"`,
        `-vf "${zoompan}${textFilter}"`,
        `-t ${segDuration}`,
        '-c:v libx264 -preset fast -crf 23',
        '-pix_fmt yuv420p',
        `-an "${segPath}"`
      ].join(' ');

      await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr.slice(-200)));
          else resolve();
        });
      });

      segmentFiles.push(segPath);
      console.log(`[${jobId}] Segment ${i + 1}/${segments.length} done`);
    }

    // Concatenate all segments
    const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    const concatPath = path.join(jobDir, 'video_only.mp4');
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${concatPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.slice(-200)));
        else resolve();
      });
    });

    // Add audio + subtitles to concatenated video
    const subsFilter = subtitles.length > 0
      ? `-vf "subtitles=${srtPath}:force_style='FontSize=42,FontName=DejaVu Sans Bold,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=50'"`
      : '';

    const finalCmd = [
      'ffmpeg -y',
      `-i "${concatPath}"`,
      `-i "${audioPath}"`,
      subsFilter,
      '-c:v libx264 -preset fast -crf 23',
      '-c:a aac -b:a 192k',
      '-pix_fmt yuv420p',
      `-t ${totalDuration}`,
      `-shortest "${outputPath}"`
    ].filter(Boolean).join(' ');

    await new Promise((resolve, reject) => {
      exec(finalCmd, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.slice(-200)));
        else resolve();
      });
    });

    const stats = fs.statSync(outputPath);
    console.log(`[${jobId}] Multi-render done! Size: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="biblical_video_${jobId}.mp4"`);
    res.setHeader('Content-Length', stats.size);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      setTimeout(() => {
        try { fs.rmSync(jobDir, { recursive: true }); } catch (e) {}
      }, 5000);
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    try { fs.rmSync(jobDir, { recursive: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Biblical Video Renderer listening on port ${PORT}`));
