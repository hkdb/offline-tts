/**
 * Copyright 2025 hkdb <hkdb@3df.io>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Offscreen document for TTS processing
// Uses webpack-bundled ONNX Runtime with WebGPU support

import * as ort from 'onnxruntime-web/webgpu';
import { loadSupertonicFromData, createStyleFromData, writeWavFile } from './lib/supertonic.js';
import * as pdfjsLib from 'pdfjs-dist';

// Configure ONNX Runtime
ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
// Enable multi-threading for better performance
// Use half of available cores, capped at 4 to avoid excessive resource usage
ort.env.wasm.numThreads = Math.min(Math.floor(navigator.hardwareConcurrency / 2) || 2, 4);
ort.env.logLevel = 'error';  // Suppress warnings (e.g., unknown CPU vendor)
console.log(`[Offscreen] WASM threads configured: ${ort.env.wasm.numThreads}`);

// Configure PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const statusEl = document.getElementById('status');
const backendStatusEl = document.getElementById('backend-status');

// State
let ttsEngine = null;
let ttsReady = false;
let initError = null;
let voiceStyles = {};
let currentBackend = 'unknown';

// PDF extraction state
let pdfExtractionId = 0;  // Increments with each extraction to invalidate previous ones

// Voice style paths
const VOICE_STYLE_PATHS = {
  M1: 'assets/voice_styles/M1.json',
  M2: 'assets/voice_styles/M2.json',
  F1: 'assets/voice_styles/F1.json',
  F2: 'assets/voice_styles/F2.json'
};

// Cache for loaded voice style data
const voiceStyleDataCache = {};

// ==== RESOURCE LOADING ====

async function fetchModelData(progressCallback) {
  const basePath = chrome.runtime.getURL('assets/onnx');
  
  progressCallback('Fetching config...');
  const cfgsResponse = await fetch(`${basePath}/tts.json`);
  const cfgs = await cfgsResponse.json();
  
  progressCallback('Fetching text processor...');
  const indexerResponse = await fetch(`${basePath}/unicode_indexer.json`);
  const indexer = await indexerResponse.json();
  
  progressCallback('Fetching duration predictor model...');
  const dpResponse = await fetch(`${basePath}/duration_predictor.onnx`);
  const dpModel = await dpResponse.arrayBuffer();
  
  progressCallback('Fetching text encoder model...');
  const textEncResponse = await fetch(`${basePath}/text_encoder.onnx`);
  const textEncModel = await textEncResponse.arrayBuffer();
  
  progressCallback('Fetching vector estimator model...');
  const vectorEstResponse = await fetch(`${basePath}/vector_estimator.onnx`);
  const vectorEstModel = await vectorEstResponse.arrayBuffer();
  
  progressCallback('Fetching vocoder model...');
  const vocoderResponse = await fetch(`${basePath}/vocoder.onnx`);
  const vocoderModel = await vocoderResponse.arrayBuffer();
  
  return {
    cfgs,
    indexer,
    dpModel,
    textEncModel,
    vectorEstModel,
    vocoderModel
  };
}

async function fetchVoiceStyleData(voice) {
  if (voiceStyleDataCache[voice]) {
    return voiceStyleDataCache[voice];
  }
  
  const url = chrome.runtime.getURL(VOICE_STYLE_PATHS[voice]);
  const response = await fetch(url);
  const data = await response.json();
  voiceStyleDataCache[voice] = data;
  return data;
}

// ==== INITIALIZATION ====

function updateBackendStatus(backend) {
  currentBackend = backend;
  const displayName = backend === 'webgpu' ? 'WebGPU (GPU Accelerated)' : 'WASM (CPU)';
  backendStatusEl.textContent = `Backend: ${displayName}`;
  backendStatusEl.classList.add('visible', backend);
  console.log('[Offscreen] Backend:', displayName);
  notifyBackground('backendStatus', { backend });
}

async function initializeTTS() {
  try {
    updateStatus('Initializing TTS engine...');
    
    // Use WASM-only mode with multi-threading for stable, efficient performance
    // WebGPU has issues with inference (hangs at step 5/5) and causes excessive CPU usage
    const executionProviders = ['wasm'];
    console.log('[Offscreen] Using WASM backend with multi-threading');
    
    updateStatus('Loading model data...');
    const modelData = await fetchModelData((msg) => updateStatus(msg));
    
    updateStatus('Initializing TTS engine...');
    ttsEngine = await loadSupertonicFromData(
      modelData,
      (msg, current, total) => updateStatus(`${msg} (${current}/${total})`),
      executionProviders
    );
    
    // Backend is WASM
    const actualBackend = 'wasm';
    updateBackendStatus(actualBackend);
    
    // Pre-load default voice style
    updateStatus('Loading default voice style...');
    const voiceStyleData = await fetchVoiceStyleData('M1');
    voiceStyles['M1'] = createStyleFromData(voiceStyleData);
    
    ttsReady = true;
    const backendDisplay = actualBackend === 'webgpu' ? 'WebGPU (GPU)' : 'WASM (CPU)';
    updateStatus(`Ready (${backendDisplay})`);
    
    notifyBackground('modelStatus', {
      status: 'ready',
      message: `OfflineTTS ready! Backend: ${backendDisplay}`,
      backend: actualBackend
    });
    
    console.log(`[Offscreen] TTS engine initialized successfully (backend: ${actualBackend})`);
    
    // Nothing is playing yet; let background close us if the user never reads anything
    startIdleTimer(IDLE_CLOSE_MS);
    
  } catch (error) {
    console.error('[Offscreen] Failed to initialize TTS:', error);
    initError = error.message;
    updateStatus('Error: ' + error.message);
    
    notifyBackground('modelStatus', {
      status: 'error',
      message: error.message
    });
  }
}

// ==== TTS SYNTHESIS ====

const DENOISING_STEPS = 5;
// User speed is applied via audio.playbackRate so it can change instantly mid-read;
// synthesizing at a fixed rate keeps buffered and new chunks consistent
const SYNTHESIS_SPEED = 1.0;

class SynthesisCancelled extends Error {}

// ONNX sessions must not run concurrently, so all synthesis goes through this queue
let engineQueue = Promise.resolve();

async function ensureVoiceStyle(voice) {
  if (!voiceStyles[voice]) {
    const voiceStyleData = await fetchVoiceStyleData(voice);
    voiceStyles[voice] = createStyleFromData(voiceStyleData);
  }
  return voiceStyles[voice];
}

/**
 * Synthesize speech from text using TTS engine
 * @param {string} text - Text to synthesize
 * @param {string} voice - Voice ID
 * @param {Function} shouldContinue - Returns false when the result is no longer wanted
 * @returns {Promise<Object>} Object containing wavBuffer, duration, synthTime
 * @throws {SynthesisCancelled} If shouldContinue() turns false before or during synthesis
 */
async function synthesize(text, voice, shouldContinue) {
  if (!ttsReady) {
    throw new Error('TTS engine not initialized');
  }
  
  const style = await ensureVoiceStyle(voice);
  
  const run = engineQueue.then(async () => {
    if (!shouldContinue()) throw new SynthesisCancelled();
    
    console.log(`[Offscreen] Synthesizing: "${text.substring(0, 50)}..." with voice ${voice} (${currentBackend})`);
    const startTime = performance.now();
    
    const { wav, duration } = await ttsEngine.call(
      text,
      style,
      DENOISING_STEPS,
      SYNTHESIS_SPEED,
      0.3,  // silence duration
      () => {
        // Called between denoising steps - abort early if the chunk is no longer needed
        if (!shouldContinue()) throw new SynthesisCancelled();
      }
    );
    
    const synthTime = (performance.now() - startTime) / 1000;
    console.log(`[Offscreen] Synthesis completed in ${synthTime.toFixed(2)}s, audio duration: ${duration[0].toFixed(2)}s`);
    
    return {
      wavBuffer: writeWavFile(wav, ttsEngine.sampleRate),
      duration: duration[0],
      synthTime
    };
  });
  
  engineQueue = run.catch(() => {});
  return run;
}

// ==== CHUNKED PLAYBACK ====

const BUFFER_AHEAD = 2;  // Number of audio chunks to pre-synthesize beyond the playing one
const DEFAULT_CHUNK_MAX_LENGTH = 200;  // Default maximum chunk length for playback
const IDLE_CLOSE_MS = 5 * 60 * 1000;     // Ask background to close us after 5 min with nothing to read
const PAUSED_CLOSE_MS = 30 * 60 * 1000;  // ...or after 30 min paused (background can resume from saved position)

/**
 * The active reading session. Replaced (never mutated back to life) on each new read,
 * so async work can detect it is stale with `s !== session`.
 * @type {{chunks: string[], voice: string, speed: number, playIndex: number,
 *         buffer: Map<number, {url: string, duration: number}>,
 *         synthesizing: number|null, paused: boolean, audio: HTMLAudioElement|null}|null}
 */
let session = null;
let idleTimer = null;

function startIdleTimer(ms) {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    console.log('[Offscreen] Idle, asking background to close offscreen document');
    notifyBackground('offscreenIdle', {});
  }, ms);
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function isCurrent(s) {
  return s === session;
}

function isWanted(s, index) {
  return isCurrent(s) && index >= s.playIndex && index <= s.playIndex + BUFFER_AHEAD;
}

/**
 * Start a new reading session, replacing any current one
 * @param {string} text - Text to read
 * @param {string} voice - Voice ID (M1, M2, F1, F2)
 * @param {number} speed - Playback speed multiplier
 * @param {number} startChunk - Chunk index to start from (used to resume after the document was closed)
 */
function startSession(text, voice, speed, startChunk = 0) {
  stopSession();
  
  if (!ttsReady) {
    failSession(null, initError ? `TTS engine failed to load: ${initError}` : 'TTS engine not ready');
    return;
  }
  
  const chunks = chunkTextForPlayback(text, DEFAULT_CHUNK_MAX_LENGTH);
  console.log(`[Offscreen] Text split into ${chunks.length} chunks`);
  
  if (chunks.length === 0) {
    failSession(null, 'No text to read');
    return;
  }
  
  const s = {
    chunks,
    voice,
    speed,
    playIndex: Math.max(0, Math.min(chunks.length - 1, startChunk)),
    buffer: new Map(),
    synthesizing: null,
    paused: false,
    audio: null
  };
  session = s;
  clearIdleTimer();
  
  updateStatus('Synthesizing...');
  notifyBackground('playbackStatus', { status: 'buffering' });
  sendProgressUpdate();
  pumpSynthesis(s);
}

/**
 * Keep the buffer filled with the playing chunk and BUFFER_AHEAD chunks after it.
 * Only one pump runs per session; seeks just move playIndex and the pump follows.
 */
async function pumpSynthesis(s) {
  if (!isCurrent(s) || s.synthesizing !== null) return;
  
  while (isCurrent(s)) {
    const index = nextIndexToSynthesize(s);
    if (index < 0) break;
    
    s.synthesizing = index;
    try {
      const result = await synthesize(s.chunks[index], s.voice, () => isWanted(s, index));
      if (!isWanted(s, index)) continue;
      
      const url = URL.createObjectURL(new Blob([result.wavBuffer], { type: 'audio/wav' }));
      s.buffer.set(index, { url, duration: result.duration });
      console.log(`[Offscreen] Chunk ${index + 1}/${s.chunks.length} ready`);
      
      if (index === s.playIndex) {
        tryPlay(s);
      }
    } catch (error) {
      if (error instanceof SynthesisCancelled || !isCurrent(s)) continue;
      console.error('[Offscreen] Synthesis error:', error);
      failSession(s, `Speech synthesis failed: ${error.message}`);
      return;
    } finally {
      s.synthesizing = null;
    }
  }
}

function nextIndexToSynthesize(s) {
  const end = Math.min(s.chunks.length, s.playIndex + BUFFER_AHEAD + 1);
  for (let i = s.playIndex; i < end; i++) {
    if (!s.buffer.has(i)) return i;
  }
  return -1;
}

function releaseChunk(s, index) {
  const entry = s.buffer.get(index);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    s.buffer.delete(index);
  }
}

function stopAudio(s) {
  if (s.audio) {
    try {
      s.audio.pause();
      // Don't set src = '' as it triggers MEDIA_ERR_SRC_NOT_SUPPORTED
    } catch (e) {
      // Ignore errors during cleanup
    }
    s.audio = null;
  }
}

/**
 * Play the chunk at playIndex if it is buffered; otherwise wait for synthesis.
 * Automatically continues to the next chunk on completion.
 */
function tryPlay(s) {
  if (!isCurrent(s) || s.paused || s.audio) return;
  
  if (s.playIndex >= s.chunks.length) {
    completeSession(s);
    return;
  }
  
  const index = s.playIndex;
  const entry = s.buffer.get(index);
  const totalChunks = s.chunks.length;
  
  if (!entry) {
    updateStatus('Buffering...');
    notifyBackground('playbackStatus', { status: 'buffering' });
    pumpSynthesis(s);
    return;
  }
  
  const audio = new Audio(entry.url);
  audio.playbackRate = s.speed;
  s.audio = audio;
  
  audio.addEventListener('ended', () => {
    if (!isCurrent(s) || s.audio !== audio) return;
    
    s.audio = null;
    releaseChunk(s, index);
    s.playIndex++;
    sendProgressUpdate();
    tryPlay(s);
    pumpSynthesis(s);
  });
  
  audio.addEventListener('error', (e) => {
    if (!isCurrent(s) || s.audio !== audio) return;
    
    const mediaError = e.target?.error;
    const errorCodes = {
      1: 'MEDIA_ERR_ABORTED',
      2: 'MEDIA_ERR_NETWORK', 
      3: 'MEDIA_ERR_DECODE',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
    };
    const errorName = errorCodes[mediaError?.code] || 'UNKNOWN';
    console.error(`[Offscreen] Audio playback error: ${errorName}: ${mediaError?.message || 'No details available'}`);
    failSession(s, `Audio playback failed (${errorName})`);
  });
  
  notifyBackground('chunkPlaying', { 
    chunkIndex: index,
    chunkText: s.chunks[index],
    totalChunks
  });
  
  if (index + 1 < totalChunks) {
    notifyBackground('chunkPreload', {
      chunkIndex: index + 1,
      chunkText: s.chunks[index + 1]
    });
  }
  
  audio.play().then(() => {
    if (!isCurrent(s) || s.audio !== audio || s.paused) return;
    
    updateStatus(`Playing ${index + 1}/${totalChunks}...`);
    notifyBackground('playbackStatus', { status: 'playing' });
    pumpSynthesis(s);
  }).catch(error => {
    // play() rejects with AbortError when paused/stopped before it started - not a failure
    if (!isCurrent(s) || s.audio !== audio || s.paused) return;
    console.error('[Offscreen] Play error:', error);
    failSession(s, `Audio playback failed: ${error.message}`);
  });
}

function stopSession() {
  const s = session;
  if (!s) return;
  
  session = null;
  stopAudio(s);
  for (const index of [...s.buffer.keys()]) {
    releaseChunk(s, index);
  }
  
  updateStatus('Stopped');
  startIdleTimer(IDLE_CLOSE_MS);
}

function completeSession(s) {
  if (!isCurrent(s)) return;
  stopSession();
  updateStatus('Ready');
  notifyBackground('playbackComplete', {});
}

/**
 * End the session (if still current) and report the error to background
 * @param {Object|null} s - Session that failed, or null for failures before a session exists
 * @param {string} message - User-facing error message
 */
function failSession(s, message) {
  if (s && !isCurrent(s)) return;
  stopSession();
  updateStatus('Error: ' + message);
  notifyBackground('playbackError', { message });
}

function pausePlayback() {
  const s = session;
  if (!s || s.paused) return;
  
  s.paused = true;
  if (s.audio) {
    s.audio.pause();
  }
  updateStatus('Paused');
  notifyBackground('playbackStatus', { status: 'paused' });
  startIdleTimer(PAUSED_CLOSE_MS);
  console.log('[Offscreen] Playback paused');
}

function resumePlayback() {
  const s = session;
  if (!s || !s.paused) return;
  
  s.paused = false;
  clearIdleTimer();
  
  if (!s.audio) {
    // Paused between chunks or while buffering
    tryPlay(s);
    return;
  }
  
  const audio = s.audio;
  audio.play().then(() => {
    if (!isCurrent(s) || s.audio !== audio || s.paused) return;
    updateStatus(`Playing ${s.playIndex + 1}/${s.chunks.length}...`);
    notifyBackground('playbackStatus', { status: 'playing' });
    console.log('[Offscreen] Playback resumed');
  }).catch(error => {
    if (!isCurrent(s) || s.audio !== audio || s.paused) return;
    console.error('[Offscreen] Resume error:', error);
    failSession(s, `Audio playback failed: ${error.message}`);
  });
}

function updatePlaybackSpeed(newSpeed) {
  if (!session) return;
  
  session.speed = newSpeed;
  if (session.audio) {
    session.audio.playbackRate = newSpeed;
  }
  console.log(`[Offscreen] Playback speed updated to ${newSpeed}x`);
}

/**
 * Seek to a specific chunk index
 * Keeps already-synthesized chunks that are still in range; the synthesis pump
 * abandons any chunk that falls out of range
 * @param {number} targetChunk - Zero-based chunk index to seek to
 */
function seekToChunk(targetChunk) {
  const s = session;
  if (!s) return;
  
  targetChunk = Math.max(0, Math.min(s.chunks.length - 1, targetChunk));
  console.log(`[Offscreen] Seeking to chunk ${targetChunk}`);
  
  if (targetChunk === s.playIndex && s.audio) {
    s.audio.currentTime = 0;
    return;
  }
  
  stopAudio(s);
  s.playIndex = targetChunk;
  for (const index of [...s.buffer.keys()]) {
    if (!isWanted(s, index)) {
      releaseChunk(s, index);
    }
  }
  
  sendProgressUpdate();
  
  if (s.paused) {
    // Stay paused, but have the new position ready
    pumpSynthesis(s);
  } else {
    tryPlay(s);
  }
}

function skipChunks(delta) {
  if (session) {
    seekToChunk(session.playIndex + delta);
  }
}

/**
 * Chunk text for playback
 * Uses section + sentence + comma splitting optimized for UI/audio playback
 * @param {string} text - Text to chunk
 * @param {number} maxLen - Maximum chunk length (default: 200)
 * @returns {string[]} Array of text chunks
 */
function chunkTextForPlayback(text, maxLen = 200) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  const chunks = [];
  const sections = text.split(/\n\s*\n/);
  
  for (const section of sections) {
    const cleanSection = section.trim().replace(/\s+/g, ' ');
    
    if (!cleanSection) continue;
    
    if (cleanSection.length <= maxLen) {
      chunks.push(cleanSection);
      continue;
    }
    
    const sentences = cleanSection.split(/(?<=[.!?])\s+/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length + 1 <= maxLen) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        if (sentence.length > maxLen) {
          const parts = sentence.split(/,\s*/);
          let partChunk = '';
          for (const part of parts) {
            if (partChunk.length + part.length + 2 <= maxLen) {
              partChunk += (partChunk ? ', ' : '') + part;
            } else {
              if (partChunk) chunks.push(partChunk.trim());
              partChunk = part;
            }
          }
          if (partChunk) currentChunk = partChunk;
        } else {
          currentChunk = sentence;
        }
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
  }
  
  return chunks.filter(c => c.length > 0);
}

// ==== PDF EXTRACTION ====

async function extractPDFText(pdfUrl) {
  // Increment extraction ID to invalidate any previous extraction
  const thisExtractionId = ++pdfExtractionId;
  console.log('[Offscreen] Extracting PDF from:', pdfUrl, '(extraction #' + thisExtractionId + ')');
  
  let pdfData;
  try {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    pdfData = await response.arrayBuffer();
  } catch (fetchError) {
    console.error('[Offscreen] Failed to fetch PDF:', fetchError);
    throw new Error(`Failed to load PDF: ${fetchError.message}. For local files, enable "Allow access to file URLs" in extension settings.`);
  }
  
  // Check if a newer extraction was started
  if (thisExtractionId !== pdfExtractionId) {
    console.log('[Offscreen] PDF extraction cancelled (superseded by extraction #' + pdfExtractionId + ')');
    throw new Error('Extraction cancelled - superseded by newer request');
  }
  
  const loadingTask = pdfjsLib.getDocument({ data: pdfData });
  const pdf = await loadingTask.promise;
  
  console.log(`[Offscreen] PDF loaded, ${pdf.numPages} pages`);
  
  // Check again after PDF load
  if (thisExtractionId !== pdfExtractionId) {
    console.log('[Offscreen] PDF extraction cancelled (superseded by extraction #' + pdfExtractionId + ')');
    throw new Error('Extraction cancelled - superseded by newer request');
  }
  
  let fullText = '';
  
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    const pageText = textContent.items
      .map(item => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (pageText) {
      fullText += pageText + '\n\n';
    }
    
    // Check periodically during extraction (every 10 pages)
    if (pageNum % 10 === 0 && thisExtractionId !== pdfExtractionId) {
      console.log('[Offscreen] PDF extraction cancelled during page processing');
      throw new Error('Extraction cancelled - superseded by newer request');
    }
  }
  
  // Final check before returning
  if (thisExtractionId !== pdfExtractionId) {
    console.log('[Offscreen] PDF extraction cancelled before completion');
    throw new Error('Extraction cancelled - superseded by newer request');
  }
  
  console.log(`[Offscreen] Extracted ${fullText.length} characters from PDF`);
  return fullText.trim() || 'No text content found in PDF.';
}

// ==== MESSAGE HANDLING FROM BACKGROUND ====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at offscreen document
  if (message.target !== 'offscreen') {
    return false;
  }
  
  console.log('[Offscreen] Received message:', message.type);
  
  if (message.type === 'getStatus') {
    sendResponse({
      ready: ttsReady,
      error: initError,
      hasSession: !!session,
      paused: !!session?.paused
    });
  } else if (message.type === 'tts') {
    startSession(message.text, message.voice, message.speed, message.startChunk || 0);
  } else if (message.type === 'stopTTS') {
    stopSession();
  } else if (message.type === 'pauseTTS') {
    pausePlayback();
  } else if (message.type === 'resumeTTS') {
    resumePlayback();
  } else if (message.type === 'seekToChunk') {
    seekToChunk(message.chunkIndex);
  } else if (message.type === 'skip') {
    skipChunks(message.delta);
  } else if (message.type === 'updateSpeed') {
    updatePlaybackSpeed(message.speed);
  } else if (message.type === 'extractPDF') {
    extractPDFText(message.url).then(text => {
      sendResponse({ success: true, text });
    }).catch(error => {
      console.error('[Offscreen] PDF extraction error:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  }
  
  return false;
});

// ==== UTILITY FUNCTIONS ====

function updateStatus(message) {
  statusEl.textContent = message;
  console.log('[Offscreen]', message);
}

function sendProgressUpdate() {
  if (!session) return;
  notifyBackground('progressUpdate', {
    currentChunk: session.playIndex,
    totalChunks: session.chunks.length
  });
}

function notifyBackground(type, data) {
  try {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {
      // Background might not be ready, ignore silently
    });
  } catch (e) {
    // Synchronous errors (e.g., extension context invalidated), ignore silently
  }
}

// ==== INITIALIZATION ====

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    updateStatus('Initializing...');
    initializeTTS();
  });
} else {
  updateStatus('Initializing...');
  initializeTTS();
}
