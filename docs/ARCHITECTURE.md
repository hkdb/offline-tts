# OfflineTTS Architecture

## Overview

OfflineTTS is a Manifest V3 Chrome extension that uses ONNX Runtime Web to run neural TTS models entirely in the browser. It provides offline text-to-speech with high-quality voices using the Supertonic TTS engine.

## Component Diagram

```
┌─────────────────┐
│   Popup UI      │  Voice selection, playback controls, speed adjustment
│   (popup.js)    │
└────────┬────────┘
         │ chrome.runtime.sendMessage
┌────────▼────────────────────────────┐
│   Background Service Worker         │  Message routing, state management,
│   (background.js)                   │  offscreen document lifecycle
└─────┬──────────────────────┬────────┘
      │                      │
      │                      │ chrome.runtime.sendMessage
┌─────▼──────────┐   ┌──────▼────────────────┐
│  Content Script│   │  Offscreen Document   │
│  (content.js)  │   │  (offscreen.js)       │
│                │   │         │             │
│  • Text extract│   │  ┌──────▼──────────┐  │
│  • Highlighting│   │  │  supertonic.js  │  │
│  • PDF detect  │   │  │  TTS Engine     │  │
└────────────────┘   │  │  (ONNX Runtime) │  │
                     │  └─────────────────┘  │
                     │  • Audio synthesis    │
                     │  • Chunked playback   │
                     │  • PDF extraction     │
                     └───────────────────────┘
```

## Component Responsibilities

### Popup (`src/popup.js`)
- User interface for voice selection, speed control, and playback buttons
- Displays loading/playback status and backend information (WASM/WebGPU)
- Seek bar for navigating through audio chunks
- Sends playback commands to background service worker

### Background Service Worker (`src/background.js`)
- Coordinates communication between popup, content script, and offscreen document
- Manages offscreen document lifecycle (creation, ready state)
- Routes messages between components
- Handles keyboard shortcuts (Alt+P, Alt+O, Alt+., Alt+,)
- Manages badge animations (playing, buffering, paused states)
- Tracks playback state across extension lifecycle

### Content Script (`src/content.js`)
- Injected into all web pages
- Extracts article text using site-specific and generic selectors
- Detects and signals PDF documents for special handling
- Highlights currently-playing text chunks with yellow background
- Preloads next chunk's highlight element for smooth scrolling
- Handles cleanup when playback stops

### Offscreen Document (`src/offscreen.js`)
- Persistent background page for audio playback (Manifest V3 requirement)
- Loads and initializes TTS models on startup
- Chunks text into ~200 character segments for playback
- Pre-buffers 2 chunks ahead for smooth playback
- Synthesizes audio using ONNX Runtime (WASM backend)
- Manages Audio elements and playback state
- Handles seeking to specific chunks
- Extracts text from PDFs using PDF.js

### TTS Engine (`src/lib/supertonic.js`)
- Implements Supertonic TTS pipeline
- Text preprocessing (Unicode normalization, emoji removal, punctuation cleanup)
- Duration prediction
- Text encoding
- Vector estimation (denoising diffusion)
- Vocoding (converts latent vectors to waveform)
- Chunks text into ~300 character segments for synthesis
- Outputs 22.05kHz mono WAV audio

## File Structure

```
.
├── src/                       # Source files (built with webpack)
│   ├── background.js          # Service worker (message routing)
│   ├── content.js             # Text extraction & highlighting
│   ├── popup.html             # UI popup
│   ├── popup.js               # Popup logic
│   ├── popup.css              # Popup styles
│   ├── offscreen.html         # Offscreen document for TTS
│   ├── offscreen.js           # TTS engine integration & playback
│   └── lib/
│       └── supertonic.js      # TTS pipeline implementation
├── build/                     # Webpack output (load this in browser)
│   ├── background.js          # Built background script
│   ├── content.js             # Built content script
│   ├── offscreen.js           # Built offscreen script
│   ├── popup.js               # Built popup script
│   ├── offscreen.html         # Offscreen HTML
│   ├── popup.html             # Popup HTML
│   ├── popup.css              # Popup styles
│   ├── manifest.json          # Extension manifest (copied)
│   ├── icons/                 # Icons (copied)
│   ├── assets/                # Models and configs (copied)
│   └── lib/                   # ONNX Runtime and PDF.js (copied)
├── assets/
│   ├── onnx/                  # TTS model files
│   │   ├── duration_predictor.onnx    # Duration model (~2MB)
│   │   ├── text_encoder.onnx          # Text encoder (~50MB)
│   │   ├── vector_estimator.onnx      # Denoiser (~150MB)
│   │   ├── vocoder.onnx               # Vocoder (~50MB)
│   │   ├── tts.json                   # Model config
│   │   └── unicode_indexer.json       # Text processor config
│   └── voice_styles/          # Voice configuration files
│       ├── M1.json            # Male voice 1
│       ├── M2.json            # Male voice 2
│       ├── F1.json            # Female voice 1
│       └── F2.json            # Female voice 2
├── icons/                     # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── icon.svg
├── scripts/
│   └── download-deps.sh       # Downloads ONNX Runtime, PDF.js, TTS models
├── docs/
│   └── ARCHITECTURE.md        # This file
├── manifest.json              # Extension configuration (Manifest V3)
├── webpack.config.js          # Build configuration
├── package.json               # Node dependencies (webpack, terser, etc.)
├── CONTRIBUTING.md            # Contribution guidelines
├── AGENTS.md                  # AI assistant guidelines
├── LICENSE                    # Apache 2.0
└── README.md                  # Main documentation
```

## Message Flow

### Reading a Page

1. **User clicks "Read Page"** → Popup sends `readPage` to Background
2. **Background** → Sends `extractText` to Content Script
3. **Content Script** → Extracts text, returns to Background
4. **Background** → Ensures offscreen document exists, sends `tts` message
5. **Offscreen** → Chunks text, synthesizes audio, plays chunks
6. **Offscreen** → Sends `chunkPlaying` to Background for each chunk
7. **Background** → Forwards `highlightChunk` to Content Script
8. **Content Script** → Highlights current text, scrolls into view

### Keyboard Shortcuts

1. **User presses Alt+P** → `chrome.commands.onCommand` fires in Background
2. **Background** → Checks state, sends `pauseTTS` or `resumeTTS` to Offscreen
3. **Offscreen** → Pauses/resumes audio, sends `playbackStatus` to Background
4. **Background** → Updates badge, forwards status to Popup

### Seeking

1. **User drags seek bar** → Popup sends `seekToChunk` to Offscreen
2. **Offscreen** → Stops current playback, clears buffer, re-synthesizes from target
3. **Offscreen** → Sends `progressUpdate` to Background
4. **Background** → Forwards to Popup to update seek bar position

## Build Process

### Setup

```bash
# Install dependencies
npm install

# Download TTS models and libraries (~300MB)
./scripts/download-deps.sh

```
### Dependencies

Downloaded via `scripts/download-deps.sh`:

| Dependency | Version | Size | Source |
|------------|---------|------|--------|
| ONNX Runtime Web | 1.17.0 | ~44 MB | jsDelivr CDN |
| PDF.js | 3.11.174 | ~2 MB | jsDelivr CDN |
| Supertonic Models | - | ~252 MB | Hugging Face |

### Development Build

```bash
npm run build:dev
```

This runs webpack in development mode, which doesn't strip `console.log`, `console.debug`, `console.trace` and outputs to the `build/` directory

### Loading in Browser

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `build/` folder (NOT the project root)

## Data Flow Details

### Text Chunking

**Playback chunking** (`offscreen.js`):
- Splits by double newlines (paragraphs)
- Then by sentences
- Then by commas if needed
- Max length: 200 characters
- Optimized for smooth UI updates

**Synthesis chunking** (`supertonic.js`):
- Splits by paragraphs
- Then by sentences (with abbreviation handling)
- Max length: 300 characters
- Optimized for TTS model quality

### Audio Buffering

- Pre-synthesizes 2 chunks ahead of playback
- Each chunk stored as WAV blob with Object URL
- URLs revoked after playback to prevent memory leaks
- Seamless transition between chunks with ~0ms gap

### Highlighting

- Searches DOM for text using first 8 words of chunk
- Falls back to 5 words if no match
- Preloads next chunk's element while current chunk plays
- Smooth scrolling with `scrollIntoView({ behavior: 'smooth', block: 'center' })`
- Yellow highlight with CSS transition

## Performance Characteristics

- **Model loading**: ~2-3 seconds (first time)
- **Synthesis**: ~0.4s per 200 chars (WASM on typical CPU)
- **Memory**: ~200MB with models loaded
- **Build size**: ~110MB (includes WebGPU WASM binaries, currently unused)

## Known Architecture Decisions

### Why Offscreen Document?

Manifest V3 service workers can't play audio or maintain long-running tasks. Offscreen documents provide a persistent background context for:
- Audio playback
- TTS model loading and inference
- PDF text extraction (requires PDF.js worker)

### Why Webpack?

- ONNX Runtime Web uses ES Modules, incompatible with direct extension loading
- Bundles imports into single files
- Enables production optimizations (tree shaking, minification, console stripping)

### Why WASM Only?

WebGPU support exists in the code but is currently disabled because:
- Hangs during inference (step 5/5)
- Causes excessive CPU usage even when idle
- Will be revisited in future after ONNX Runtime updates

### Why Two chunkText Functions?

- `chunkTextForPlayback()` (200 chars) - optimized for UI responsiveness
- `chunkTextForSynthesis()` (300 chars) - optimized for TTS model quality
- Different use cases require different trade-offs

## Extension Permissions

```json
{
  "permissions": ["storage", "contextMenus", "offscreen"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"]
  }]
}
```

- `storage`: Save voice/speed preferences
- `contextMenus`: "Read with OfflineTTS" on text selection
- `offscreen`: Create offscreen document for TTS/audio
- `<all_urls>`: Extract text from any webpage

## Possible Future Architecture Improvements

1. **Streaming Audio** - Start playback before full synthesis
2. **WebGPU Support** - Requires fixing ONNX Runtime inference issues
3. **Service Worker Persistence** - Better handling of service worker sleep/wake
4. **Model Caching** - Store models in IndexedDB to reduce load time
