# Biblical Video Renderer

FFmpeg server for automated biblical YouTube video production.

## Deploy to Railway (free)

1. Go to https://github.com/new and create a new repo called `biblical-video-renderer`
2. Upload all 4 files: server.js, package.json, Dockerfile, railway.toml
3. Go to https://railway.app → New Project → Deploy from GitHub repo
4. Select your repo → Railway auto-detects the Dockerfile and deploys
5. Go to Settings → Networking → Generate Domain
6. Copy your URL (e.g. https://biblical-video-renderer.railway.app)
7. Paste that URL into n8n as RENDER_SERVER_URL

## API Endpoints

### POST /render (single image)
```json
{
  "imageUrl": "https://...",
  "audioUrl": "https://...",
  "subtitles": [{"text": "...", "start": 0, "end": 3}],
  "overlayText": "Most people never realize...",
  "duration": 20
}
```
Returns: MP4 video file

### POST /render-multi (multiple images)
```json
{
  "audioUrl": "https://...",
  "totalDuration": 120,
  "segments": [
    {"imageUrl": "https://...", "overlayText": "...", "startTime": 0, "endTime": 30},
    {"imageUrl": "https://...", "overlayText": "...", "startTime": 30, "endTime": 60}
  ],
  "subtitles": [{"text": "...", "start": 0, "end": 3}]
}
```
Returns: MP4 video file

## Video Features
- Ken Burns zoom effect on all images
- Bold white text overlay with black shadow (left side)
- Burned-in subtitles (bottom center)
- 1920x1080 output at 25fps
- AAC audio at 192kbps
