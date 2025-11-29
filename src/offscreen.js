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
let voiceStyles = {};
let currentAudio = null;
let isPlaying = false;
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

// ==== WEBGPU DETECTION ====

async function detectWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
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
    
  } catch (error) {
    console.error('[Offscreen] Failed to initialize TTS:', error);
    updateStatus('Error: ' + error.message);
    
    notifyBackground('modelStatus', {
      status: 'error',
      message: error.message
    });
  }
}

// ==== TTS SYNTHESIS ====

/**
 * Synthesize speech from text using TTS engine
 * @param {string} text - Text to synthesize
 * @param {string} voice - Voice ID
 * @param {number} speed - Speed multiplier
 * @param {number} steps - Number of denoising steps (default: 5)
 * @returns {Promise<Object>} Object containing wavBuffer, duration, sampleRate, synthTime, backend
 */
async function synthesize(text, voice, speed, steps = 5) {
  if (!ttsReady) {
    throw new Error('TTS engine not initialized');
  }
  
  // Load voice style if not already loaded
  if (!voiceStyles[voice]) {
    const voiceStyleData = await fetchVoiceStyleData(voice);
    voiceStyles[voice] = createStyleFromData(voiceStyleData);
  }
  
  updateStatus(`Synthesizing speech (${voice}, ${speed}x, ${currentBackend})...`);
  console.log(`[Offscreen] Synthesizing: "${text.substring(0, 50)}..." with voice ${voice} at ${speed}x (${currentBackend})`);
  
  const startTime = performance.now();
  
  // Call TTS engine
  const { wav, duration } = await ttsEngine.call(
    text,
    voiceStyles[voice],
    steps,
    speed,
    0.3,  // silence duration
    (step, totalSteps) => {
      console.log(`[Offscreen] Denoising step ${step}/${totalSteps}`);
    }
  );
  
  const endTime = performance.now();
  const synthTime = ((endTime - startTime) / 1000).toFixed(2);
  const audioDuration = duration[0];
  console.log(`[Offscreen] Synthesis completed in ${synthTime}s, audio duration: ${audioDuration.toFixed(2)}s (${currentBackend})`);
  
  updateStatus('Synthesis complete');
  
  // Convert to WAV
  const wavBuffer = writeWavFile(wav, ttsEngine.sampleRate);
  
  return {
    wavBuffer,
    duration: audioDuration,
    sampleRate: ttsEngine.sampleRate,
    synthTime: parseFloat(synthTime),
    backend: currentBackend
  };
}

// ==== CHUNKED PLAYBACK ====

let textChunks = [];
let currentChunkIndex = 0;
let currentVoice = 'M1';
let currentSpeed = 1.0;
let stopRequested = false;

// Pre-buffer state
let audioBuffer = [];
let isSynthesizing = false;
let synthesizeIndex = 0;
const BUFFER_AHEAD = 2;  // Number of audio chunks to pre-synthesize for smooth playback
const DEFAULT_CHUNK_MAX_LENGTH = 200;  // Default maximum chunk length for playback

// Seek/playback locking
let isSeeking = false;
let playbackSessionId = 0;
let lastSeekTarget = -1;
let lastSeekTime = 0;

function cleanupAudio(audio) {
  if (!audio) return;
  
  try {
    audio.pause();
    // Don't set src = '' as it triggers MEDIA_ERR_SRC_NOT_SUPPORTED
  } catch (e) {
    // Ignore errors during cleanup
  }
}

/**
 * Handle TTS request from background script
 * Stops any current playback, chunks text, synthesizes audio, and starts playback
 * @param {string} text - Text to synthesize
 * @param {string} voice - Voice ID (M1, M2, F1, F2)
 * @param {number} speed - Playback speed multiplier
 */
async function handleTTSRequest(text, voice, speed) {
  try {
    stopPlayback();
    stopRequested = false;
    
    playbackSessionId++;
    console.log(`[Offscreen] Starting new TTS session: ${playbackSessionId}`);
    
    if (!ttsReady) {
      throw new Error('TTS engine not ready');
    }
    
    // Load voice style if not already loaded
    if (!voiceStyles[voice]) {
      const voiceStyleData = await fetchVoiceStyleData(voice);
      voiceStyles[voice] = createStyleFromData(voiceStyleData);
    }
    
    textChunks = chunkTextForPlayback(text, DEFAULT_CHUNK_MAX_LENGTH);
    currentChunkIndex = 0;
    synthesizeIndex = 0;
    currentVoice = voice;
    currentSpeed = speed;
    audioBuffer = [];
    
    console.log(`[Offscreen] Text split into ${textChunks.length} chunks`);
    
    if (textChunks.length === 0) {
      throw new Error('No text to synthesize');
    }
    
    updateStatus('Synthesizing...');
    await synthesizeNextChunks();
    
    playFromBuffer();
    
  } catch (error) {
    console.error('[Offscreen] TTS error:', error);
    updateStatus('Error: ' + error.message);
    
    // If error is "TTS engine not ready", don't report as error - it's loading
    if (error.message === 'TTS engine not ready') {
      console.log('[Offscreen] TTS called while still loading, ignoring');
      // Don't send error status, let initialization continue
    } else {
      notifyBackground('modelStatus', {
        status: 'error',
        message: error.message
      });
    }
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

async function synthesizeNextChunks() {
  if (isSynthesizing || stopRequested) {
    return;
  }
  
  isSynthesizing = true;
  
  try {
    while (synthesizeIndex < textChunks.length && 
           audioBuffer.length < BUFFER_AHEAD && 
           !stopRequested) {
      
      const chunk = textChunks[synthesizeIndex];
      const chunkNum = synthesizeIndex + 1;
      const totalChunks = textChunks.length;
      
      console.log(`[Offscreen] Pre-synthesizing chunk ${chunkNum}/${totalChunks}: "${chunk.substring(0, 40)}..."`);
      
      const result = await synthesize(chunk, currentVoice, currentSpeed, 5);
      
      if (stopRequested) {
        break;
      }
      
      console.log(`[Offscreen] Chunk ${chunkNum} ready (${result.synthTime}s synth, ${result.duration.toFixed(2)}s audio)`);
      
      const audioBlob = new Blob([result.wavBuffer], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(audioBlob);
      
      audioBuffer.push({
        url: audioUrl,
        duration: result.duration,
        chunkIndex: synthesizeIndex
      });
      
      synthesizeIndex++;
    }
  } catch (error) {
    console.error('[Offscreen] Synthesis error:', error);
  } finally {
    isSynthesizing = false;
  }
}

/**
 * Play next audio chunk from the buffer
 * Handles buffering, audio element creation, event listeners, and progress tracking
 * Automatically continues to next chunk on completion
 */
async function playFromBuffer() {
  const sessionId = playbackSessionId;
  
  if (stopRequested) {
    return;
  }
  
  if (currentAudio) {
    cleanupAudio(currentAudio);
    currentAudio = null;
  }
  
  if (audioBuffer.length === 0) {
    if (synthesizeIndex < textChunks.length) {
      updateStatus('Buffering...');
      setTimeout(() => {
        if (sessionId === playbackSessionId) {
          playFromBuffer();
        }
      }, 100);
      return;
    } else {
      isPlaying = false;
      updateStatus('Ready');
      notifyBackground('playbackComplete', {});
      return;
    }
  }
  
  const audioData = audioBuffer.shift();
  const chunkNum = audioData.chunkIndex + 1;
  const totalChunks = textChunks.length;
  
  currentAudio = new Audio(audioData.url);
  currentAudio.playbackRate = currentSpeed;
  
  updateStatus(`Buffering ${chunkNum}/${totalChunks}...`);
  
  if (audioData.chunkIndex === 0) {
    await new Promise(resolve => setTimeout(resolve, 150));
    
    if (sessionId !== playbackSessionId) {
      console.log('[Offscreen] Session changed during startup delay, aborting');
      cleanupAudio(currentAudio);
      currentAudio = null;
      URL.revokeObjectURL(audioData.url);
      return;
    }
  }
  
  // Defensive check: ensure currentAudio still exists (race condition protection)
  if (!currentAudio) {
    console.log('[Offscreen] currentAudio is null, aborting playback');
    URL.revokeObjectURL(audioData.url);
    return;
  }
  
  currentAudio.addEventListener('ended', () => {
    URL.revokeObjectURL(audioData.url);
    
    if (sessionId !== playbackSessionId) {
      console.log('[Offscreen] Ignoring ended event from old session');
      return;
    }
    
    currentChunkIndex++;
    playFromBuffer();
    synthesizeNextChunks();
  });
  
  currentAudio.addEventListener('error', (e) => {
    if (sessionId !== playbackSessionId) return;
    
    const mediaError = e.target?.error;
    const errorCodes = {
      1: 'MEDIA_ERR_ABORTED',
      2: 'MEDIA_ERR_NETWORK', 
      3: 'MEDIA_ERR_DECODE',
      4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
    };
    const errorCode = mediaError?.code;
    const errorName = errorCodes[errorCode] || 'UNKNOWN';
    const errorMsg = mediaError?.message || 'No details available';
    
    console.error(`[Offscreen] Audio playback error: ${errorName} (code ${errorCode}): ${errorMsg}`);
    URL.revokeObjectURL(audioData.url);
    updateStatus(`Playback error: ${errorName}`);
    isPlaying = false;
  });
  
  notifyBackground('chunkPlaying', { 
    chunkIndex: audioData.chunkIndex,
    chunkText: textChunks[audioData.chunkIndex],
    totalChunks: totalChunks
  });
  
  const nextChunkIndex = audioData.chunkIndex + 1;
  if (nextChunkIndex < textChunks.length) {
    notifyBackground('chunkPreload', {
      chunkIndex: nextChunkIndex,
      chunkText: textChunks[nextChunkIndex]
    });
  }
  
  try {
    await currentAudio.play();
    
    if (sessionId !== playbackSessionId) {
      console.log('[Offscreen] Session changed during play, aborting');
      cleanupAudio(currentAudio);
      currentAudio = null;
      return;
    }
    
    isPlaying = true;
    updateStatus(`Playing ${chunkNum}/${totalChunks}...`);
    
    notifyBackground('playbackStatus', { status: 'playing' });
    sendProgressUpdate();
    synthesizeNextChunks();
    
  } catch (error) {
    console.error('[Offscreen] Play error:', error);
    URL.revokeObjectURL(audioData.url);
  }
}

function stopPlayback() {
  stopRequested = true;
  isPaused = false;
  
  playbackSessionId++;
  
  if (currentAudio) {
    cleanupAudio(currentAudio);
    currentAudio = null;
  }
  
  for (const audioData of audioBuffer) {
    URL.revokeObjectURL(audioData.url);
  }
  audioBuffer = [];
  
  isPlaying = false;
  isSynthesizing = false;
  isSeeking = false;
  textChunks = [];
  currentChunkIndex = 0;
  synthesizeIndex = 0;
  
  updateStatus('Stopped');
}

let isPaused = false;

function pausePlayback() {
  if (currentAudio && isPlaying && !isPaused) {
    currentAudio.pause();
    isPaused = true;
    updateStatus('Paused');
    notifyBackground('playbackStatus', { status: 'paused' });
    console.log('[Offscreen] Playback paused');
  }
}

function resumePlayback() {
  if (currentAudio && isPaused) {
    currentAudio.play().then(() => {
      isPaused = false;
      const chunkNum = currentChunkIndex + 1;
      const totalChunks = textChunks.length;
      updateStatus(`Playing ${chunkNum}/${totalChunks}...`);
      notifyBackground('playbackStatus', { status: 'playing' });
      console.log('[Offscreen] Playback resumed');
    }).catch(error => {
      console.error('[Offscreen] Resume error:', error);
    });
  } else if (!currentAudio && audioBuffer.length > 0) {
    isPaused = false;
    playFromBuffer();
  }
}

function updatePlaybackSpeed(newSpeed) {
  currentSpeed = newSpeed;
  
  if (currentAudio) {
    currentAudio.playbackRate = newSpeed;
    console.log(`[Offscreen] Playback speed updated to ${newSpeed}x`);
  }
}

/**
 * Seek to a specific chunk index
 * Stops current playback, clears buffer, re-synthesizes from target chunk
 * @param {number} targetChunk - Zero-based chunk index to seek to
 */
async function seekToChunk(targetChunk) {
  console.log(`[Offscreen] Seeking to chunk ${targetChunk}`);
  
  if (textChunks.length === 0) return;
  
  // Reject duplicate seek requests within 500ms
  const now = Date.now();
  if (targetChunk === lastSeekTarget && now - lastSeekTime < 2000) {
    console.log('[Offscreen] Ignoring duplicate seek to chunk', targetChunk);
    return;
  }
  lastSeekTarget = targetChunk;
  lastSeekTime = now;
  
  if (isSeeking) {
    console.log('[Offscreen] Seek already in progress, ignoring');
    return;
  }
  isSeeking = true;
  
  playbackSessionId++;
  console.log(`[Offscreen] New playback session: ${playbackSessionId}`);
  
  try {
    targetChunk = Math.max(0, Math.min(textChunks.length - 1, targetChunk));
    
    if (targetChunk === currentChunkIndex && currentAudio) {
      currentAudio.currentTime = 0;
      if (isPaused) {
        currentAudio.play();
        isPaused = false;
        notifyBackground('playbackStatus', { status: 'playing' });
      }
      return;
    }
    
    if (currentAudio) {
      cleanupAudio(currentAudio);
      currentAudio = null;
    }
    
    for (const audioData of audioBuffer) {
      URL.revokeObjectURL(audioData.url);
    }
    audioBuffer = [];
    
    currentChunkIndex = targetChunk;
    synthesizeIndex = targetChunk;
    
    sendProgressUpdate();
    
    isPaused = false;
    stopRequested = true;  // Signal ongoing synthesis to stop
    
    // Wait for ongoing synthesis to finish (if any)
    let waitAttempts = 0;
    while (isSynthesizing && waitAttempts < 50) {  // Max 500ms wait
      await new Promise(resolve => setTimeout(resolve, 10));
      waitAttempts++;
    }
    
    stopRequested = false;  // Allow new synthesis to proceed
    
    updateStatus(`Seeking to chunk ${targetChunk + 1}...`);
    notifyBackground('playbackStatus', { status: 'buffering' });
    
    await synthesizeNextChunks();
    playFromBuffer();
  } finally {
    isSeeking = false;
  }
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
  
  if (message.type === 'tts') {
    handleTTSRequest(message.text, message.voice, message.speed);
  } else if (message.type === 'stopTTS') {
    stopPlayback();
  } else if (message.type === 'pauseTTS') {
    pausePlayback();
  } else if (message.type === 'resumeTTS') {
    resumePlayback();
  } else if (message.type === 'seekToChunk') {
    seekToChunk(message.chunkIndex);
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
  notifyBackground('progressUpdate', {
    currentChunk: currentChunkIndex,
    totalChunks: textChunks.length
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
