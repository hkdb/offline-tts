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

// Popup UI logic
//
// Renders from chrome.storage.session (written by background) and sends all
// commands to background, which owns the offscreen document
const statusEl = document.getElementById('status');
const voiceSelect = document.getElementById('voice-select');
const speedRange = document.getElementById('speed-range');
const speedValue = document.getElementById('speed-value');
const playBtn = document.getElementById('play-btn');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');

// Seek bar elements
const seekBackBtn = document.getElementById('seek-back-btn');
const seekForwardBtn = document.getElementById('seek-forward-btn');
const seekTrack = document.getElementById('seek-track');
const seekFill = document.getElementById('seek-fill');
const seekHandle = document.getElementById('seek-handle');
const chunkCurrentEl = document.getElementById('chunk-current');
const chunkTotalEl = document.getElementById('chunk-total');

const HOLD_DELAY_MS = 300;  // Press longer than this on a skip button to scrub instead of skipping once

// Mirror of the session storage keys written by background
const state = {
  playbackStatus: 'stopped',
  modelStatus: null,
  modelError: null,
  backend: null,
  currentChunk: 0,
  totalChunks: 0
};
let errorMessage = null;  // Last error reported by background, shown until state changes

// Seek bar state
let pendingChunk = null;  // The chunk we're seeking to (while dragging/holding)
let holdDirection = 0;
let holdTimeout = null;
let holdInterval = null;
let isDragging = false;
let isHolding = false;

// Ask background to start loading models now so they're ready when the user clicks Read
chrome.runtime.sendMessage({ type: 'warmup' }).catch(() => {});

// Update speed slider fill
function updateSpeedSliderFill() {
  const min = parseFloat(speedRange.min);
  const max = parseFloat(speedRange.max);
  const val = parseFloat(speedRange.value);
  const percent = ((val - min) / (max - min)) * 100;
  const trackColor = window.matchMedia('(prefers-color-scheme: dark)').matches ? '#444' : '#ddd';
  speedRange.style.background = `linear-gradient(to right, #2f96f6 0%, #2f96f6 ${percent}%, ${trackColor} ${percent}%, ${trackColor} 100%)`;
}

// Update speed display and apply live
speedRange.addEventListener('input', () => {
  const newSpeed = parseFloat(speedRange.value);
  speedValue.textContent = `${speedRange.value}x`;
  chrome.storage.local.set({ speed: newSpeed });
  updateSpeedSliderFill();
  
  chrome.runtime.sendMessage({ type: 'setSpeed', speed: newSpeed }).catch(() => {});
});

// Initialize slider fill on load
updateSpeedSliderFill();

// Save voice selection
voiceSelect.addEventListener('change', () => {
  chrome.storage.local.set({ voice: voiceSelect.value });
});

// Load saved settings
chrome.storage.local.get(['voice', 'speed'], (result) => {
  if (result.voice) voiceSelect.value = result.voice;
  if (result.speed) {
    speedRange.value = result.speed;
    speedValue.textContent = `${result.speed}x`;
    updateSpeedSliderFill();
  }
});

// Load playback/model state and follow changes
chrome.storage.session.get(Object.keys(state), (result) => {
  Object.assign(state, result);
  render();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session') return;
  
  let changed = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in state) {
      state[key] = newValue;
      changed = true;
    }
  }
  if (changed) {
    if (changes.playbackStatus) {
      errorMessage = null;
    }
    render();
  }
});

// Errors are transient, so background sends them as messages
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'error') {
    errorMessage = message.message || 'An error occurred';
    render();
  }
});

// ============ RENDERING ============

function render() {
  const status = state.playbackStatus || 'stopped';
  const modelsReady = state.modelStatus === 'ready';
  
  // Buttons
  const active = status !== 'stopped';
  playBtn.disabled = active || state.modelStatus === 'error';
  pauseBtn.disabled = !active;
  pauseBtn.textContent = status === 'paused' ? '▶' : '❚❚';
  stopBtn.disabled = !active;
  seekBackBtn.disabled = !active || state.totalChunks <= 0;
  seekForwardBtn.disabled = !active || state.totalChunks <= 0;
  
  // Status line
  if (errorMessage) {
    showStatus('error', errorMessage);
  } else if (state.modelStatus === 'error') {
    showStatus('error', `Error loading models: ${state.modelError || 'check console'}`);
  } else if (status === 'buffering') {
    showStatus('loading', modelsReady ? 'Buffering...' : 'Loading models... Please wait.');
  } else if (status === 'playing') {
    showStatus('ready', 'Playing...');
  } else if (status === 'paused') {
    showStatus('ready', 'Paused');
  } else if (modelsReady) {
    showStatus('ready', 'Ready to read.');
  } else {
    showStatus('loading', 'Loading models...');
  }
  
  updateSeekBar();
}

function showStatus(type, message) {
  const statusTextEl = document.getElementById('status-text');
  const backendBadgeEl = document.getElementById('backend-badge');
  
  statusEl.className = `status ${type}`;
  statusTextEl.textContent = message;
  
  // Show backend badge if available (except for loading/error states)
  if (state.backend && type !== 'loading' && type !== 'error') {
    const displayName = state.backend === 'webgpu' ? '⚡ WebGPU' : '🔧 WASM (CPU)';
    backendBadgeEl.textContent = displayName;
    backendBadgeEl.className = `backend-badge ${state.backend}`;
  } else {
    backendBadgeEl.className = 'backend-badge hidden';
  }
}

// ============ PLAYBACK BUTTONS ============

// Guard against rapid double-clicks
let isReadRequestInProgress = false;

// Read current page
playBtn.addEventListener('click', async () => {
  // Prevent double-clicks
  if (isReadRequestInProgress) return;
  isReadRequestInProgress = true;
  
  // Immediate feedback before async operations
  playBtn.disabled = true;
  errorMessage = null;
  showStatus('loading', 'Starting...');
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.runtime.sendMessage({
      type: 'readPage',
      tabId: tab.id,
      voice: voiceSelect.value,
      speed: parseFloat(speedRange.value)
    }).catch(() => {});
  }
  
  // Reset flag after a short delay to allow legitimate re-clicks
  setTimeout(() => { isReadRequestInProgress = false; }, 1000);
});

// Pause/Resume reading
pauseBtn.addEventListener('click', () => {
  const type = state.playbackStatus === 'paused' ? 'resumeReading' : 'pauseReading';
  chrome.runtime.sendMessage({ type }).catch(() => {});
});

// Stop reading
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stopReading' }).catch(() => {});
});

// ============ SEEK BAR LOGIC ============

// Update seek bar visuals from state (chunk numbers shown 1-based)
function updateSeekBar() {
  const total = state.totalChunks || 0;
  const current = state.currentChunk || 0;
  
  chunkTotalEl.textContent = total;
  
  // Don't update position if user is dragging or holding
  if (!isDragging && !isHolding) {
    chunkCurrentEl.textContent = total > 0 ? current + 1 : 0;
    setSeekPosition(chunkToPercent(current));
  }
}

// Set seek bar visual position (0-100%)
function setSeekPosition(percent) {
  percent = Math.max(0, Math.min(100, percent));
  seekFill.style.width = `${percent}%`;
  seekHandle.style.left = `${percent}%`;
}

// Convert percent to chunk index
function percentToChunk(percent) {
  if (state.totalChunks <= 0) return 0;
  const chunk = Math.round((percent / 100) * (state.totalChunks - 1));
  return Math.max(0, Math.min(state.totalChunks - 1, chunk));
}

// Convert chunk index to percent
function chunkToPercent(chunk) {
  if (state.totalChunks <= 1) return 0;
  return (chunk / (state.totalChunks - 1)) * 100;
}

function showPendingChunk(chunk) {
  setSeekPosition(chunkToPercent(chunk));
  chunkCurrentEl.textContent = chunk + 1;
}

function sendSeek(chunkIndex) {
  chrome.runtime.sendMessage({ type: 'seek', chunkIndex }).catch(() => {});
}

function sendSkip(delta) {
  chrome.runtime.sendMessage({ type: 'skip', delta }).catch(() => {});
}

// Commit the seek (actually jump to the pending chunk)
function commitSeek() {
  if (pendingChunk !== null && pendingChunk !== state.currentChunk) {
    sendSeek(pendingChunk);
  }
  pendingChunk = null;
}

// Move pending position by delta chunks
function movePendingBy(delta) {
  if (state.totalChunks <= 0) return;
  
  const base = pendingChunk !== null ? pendingChunk : state.currentChunk;
  pendingChunk = Math.max(0, Math.min(state.totalChunks - 1, base + delta));
  showPendingChunk(pendingChunk);
}

// ============ SKIP BUTTONS (click = skip one chunk, hold = scrub) ============

function startHold(direction) {
  holdDirection = direction;
  holdTimeout = setTimeout(() => {
    holdTimeout = null;
    isHolding = true;
    pendingChunk = state.currentChunk;
    movePendingBy(direction);
    holdInterval = setInterval(() => movePendingBy(direction), 150);
  }, HOLD_DELAY_MS);
}

/**
 * @param {boolean} cancelled - Pointer left the button: commit a scrub, but don't count it as a click
 */
function endHold(cancelled) {
  if (holdDirection === 0) return;
  
  clearTimeout(holdTimeout);
  clearInterval(holdInterval);
  holdTimeout = null;
  holdInterval = null;
  
  if (isHolding) {
    isHolding = false;
    commitSeek();
    updateSeekBar();
  } else if (!cancelled) {
    sendSkip(holdDirection);
  }
  holdDirection = 0;
}

for (const [button, direction] of [[seekBackBtn, -1], [seekForwardBtn, 1]]) {
  button.addEventListener('mousedown', (e) => {
    if (button.disabled || e.button !== 0) return;
    e.preventDefault();
    startHold(direction);
  });
  button.addEventListener('mouseleave', () => endHold(true));
  
  // Keyboard activation (Enter/Space) fires click without mousedown
  button.addEventListener('click', (e) => {
    if (!button.disabled && e.detail === 0) {
      sendSkip(direction);
    }
  });
}

document.addEventListener('mouseup', () => endHold(false));

// ============ DRAG HANDLE ============

seekHandle.addEventListener('mousedown', (e) => {
  if (state.totalChunks <= 0) return;
  e.preventDefault();
  e.stopPropagation();  // Prevent mousedown from bubbling to track
  isDragging = true;
  pendingChunk = state.currentChunk;
  seekHandle.style.cursor = 'grabbing';
});

// Prevent click event from bubbling to track (separate from mousedown)
seekHandle.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  
  const rect = seekTrack.getBoundingClientRect();
  const percent = ((e.clientX - rect.left) / rect.width) * 100;
  
  pendingChunk = percentToChunk(percent);
  showPendingChunk(pendingChunk);
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    seekHandle.style.cursor = 'grab';
    commitSeek();
    updateSeekBar();
  }
});

// ============ CLICK ON TRACK ============

seekTrack.addEventListener('click', (e) => {
  if (state.totalChunks <= 0 || isDragging) return;
  
  const rect = seekTrack.getBoundingClientRect();
  const percent = ((e.clientX - rect.left) / rect.width) * 100;
  const targetChunk = percentToChunk(percent);
  
  // Update visual immediately
  showPendingChunk(targetChunk);
  sendSeek(targetChunk);
});
