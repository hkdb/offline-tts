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

let currentlyPaused = false;
let currentBackend = null; // Store current backend (webgpu/wasm)
let currentStatusType = 'loading'; // Store current status type
let currentStatusMessage = 'Loading models...'; // Store current status message

// Seek bar state
let totalChunks = 0;
let currentChunk = 0;
let pendingChunk = null;  // The chunk we're seeking to (while dragging/holding)
let holdInterval = null;
let isDragging = false;
let isHolding = false;

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
  
  // Send live speed update to offscreen for immediate effect
  chrome.runtime.sendMessage({ 
    target: 'offscreen', 
    type: 'updateSpeed', 
    speed: newSpeed 
  });
});

// Initialize slider fill on load
updateSpeedSliderFill();

// Save voice selection
voiceSelect.addEventListener('change', () => {
  chrome.storage.local.set({ voice: voiceSelect.value });
});

// Load saved settings and playback state
chrome.storage.local.get(['voice', 'speed', 'modelStatus', 'playbackStatus', 'backend'], (result) => {
  // Store backend if available
  if (result.backend) {
    currentBackend = result.backend;
  }
  if (result.voice) voiceSelect.value = result.voice;
  if (result.speed) {
    speedRange.value = result.speed;
    speedValue.textContent = `${result.speed}x`;
    updateSpeedSliderFill();
  }
  
  if (result.modelStatus === 'ready') {
    // Check playback status
    if (result.playbackStatus === 'buffering') {
      showStatus('loading', 'Buffering...');
      setBufferingState();
    } else if (result.playbackStatus === 'playing') {
      showStatus('ready', 'Playing...');
      setPlayingState();
    } else if (result.playbackStatus === 'paused') {
      showStatus('ready', 'Paused');
      setPausedState();
    } else {
      showStatus('ready', 'Models loaded! Ready to read.');
      setStoppedState();
    }
  } else if (result.modelStatus === 'error') {
    showStatus('error', 'Error loading models. Check console.');
  } else {
    // Still loading
    showStatus('loading', 'Loading models...');
    setLoadingState();
  }
});

// Listen for model status updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'modelStatus') {
    if (message.status === 'loading') {
      showStatus('loading', message.message || 'Loading models...');
    } else if (message.status === 'ready') {
      playBtn.disabled = false;
      chrome.storage.local.set({ modelStatus: 'ready' });
      // Store backend if included in message
      if (message.backend) {
        currentBackend = message.backend;
        chrome.storage.local.set({ backend: message.backend });
      }
      showStatus('ready', 'Models loaded! Ready to read.');
    } else if (message.status === 'error') {
      showStatus('error', `Error: ${message.message}`);
      chrome.storage.local.set({ modelStatus: 'error' });
    }
  } else if (message.type === 'backendStatus') {
    // Handle dedicated backend status update
    currentBackend = message.backend;
    chrome.storage.local.set({ backend: message.backend });
    // Refresh the current status to show backend
    showStatus(currentStatusType, currentStatusMessage);
  } else if (message.type === 'playbackStatus') {
    if (message.status === 'buffering') {
      setBufferingState();
      // Check if models are still loading
      chrome.storage.local.get(['modelStatus'], (result) => {
        if (result.modelStatus !== 'ready') {
          showStatus('loading', 'Loading models... Please wait.');
        } else {
          showStatus('loading', 'Buffering...');
        }
      });
    } else if (message.status === 'playing') {
      setPlayingState();
      showStatus('ready', 'Playing...');
    } else if (message.status === 'paused') {
      setPausedState();
      showStatus('ready', 'Paused');
    } else if (message.status === 'stopped') {
      setStoppedState();
      showStatus('ready', 'Ready to read.');
    }
  } else if (message.type === 'progressUpdate') {
    // Update seek bar position
    updateSeekBar(message.currentChunk, message.totalChunks);
  } else if (message.type === 'error') {
    // Show error message from background
    showStatus('error', message.message || 'An error occurred');
    setStoppedState();
  }
});

// State management functions
function setBufferingState() {
  playBtn.disabled = true;
  pauseBtn.disabled = true;
  pauseBtn.textContent = '❚❚';
  stopBtn.disabled = false; // Allow stopping while buffering
  seekBackBtn.disabled = true;
  seekForwardBtn.disabled = true;
  currentlyPaused = false;
}

function setPlayingState() {
  playBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = '❚❚';
  stopBtn.disabled = false;
  seekBackBtn.disabled = false;
  seekForwardBtn.disabled = false;
  currentlyPaused = false;
}

function setPausedState() {
  playBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = '▶';
  stopBtn.disabled = false;
  seekBackBtn.disabled = false;
  seekForwardBtn.disabled = false;
  currentlyPaused = true;
}

function setStoppedState() {
  playBtn.disabled = false;
  pauseBtn.disabled = true;
  pauseBtn.textContent = '❚❚';
  stopBtn.disabled = true;
  seekBackBtn.disabled = true;
  seekForwardBtn.disabled = true;
  currentlyPaused = false;
  // Reset seek bar
  updateSeekBar(0, 0);
}

function setLoadingState() {
  playBtn.disabled = true;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  seekBackBtn.disabled = true;
  seekForwardBtn.disabled = true;
}

// Guard against rapid double-clicks
let isReadRequestInProgress = false;

// Read current page
playBtn.addEventListener('click', async () => {
  // Prevent double-clicks
  if (isReadRequestInProgress) return;
  isReadRequestInProgress = true;
  
  // Immediate feedback before async operations
  playBtn.disabled = true;
  showStatus('loading', 'Starting...');
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  chrome.runtime.sendMessage({
    type: 'readPage',
    tabId: tab.id,
    voice: voiceSelect.value,
    speed: parseFloat(speedRange.value)
  });
  
  // Reset flag after a short delay to allow legitimate re-clicks
  setTimeout(() => { isReadRequestInProgress = false; }, 1000);
});

// Pause/Resume reading
pauseBtn.addEventListener('click', () => {
  if (currentlyPaused) {
    chrome.runtime.sendMessage({ type: 'resumeReading' });
  } else {
    chrome.runtime.sendMessage({ type: 'pauseReading' });
  }
});

// Stop reading
stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stopReading' });
});

// ============ SEEK BAR LOGIC ============

// Update seek bar visuals
function updateSeekBar(current, total) {
  currentChunk = current;
  totalChunks = total;
  
  chunkCurrentEl.textContent = current;
  chunkTotalEl.textContent = total;
  
  // Don't update position if user is dragging or holding
  if (!isDragging && !isHolding) {
    const percent = total > 0 ? (current / total) * 100 : 0;
    setSeekPosition(percent);
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
  if (totalChunks <= 0) return 0;
  return Math.round((percent / 100) * (totalChunks - 1));
}

// Convert chunk index to percent
function chunkToPercent(chunk) {
  if (totalChunks <= 1) return 0;
  return (chunk / (totalChunks - 1)) * 100;
}

// Commit the seek (actually jump to the pending chunk)
function commitSeek() {
  if (pendingChunk !== null && pendingChunk !== currentChunk) {
    console.log('[Popup] commitSeek() sending seek to chunk:', pendingChunk);
    console.trace('[Popup] commitSeek() call stack');
    chrome.runtime.sendMessage({ 
      target: 'offscreen', 
      type: 'seekToChunk', 
      chunkIndex: pendingChunk 
    });
  }
  pendingChunk = null;
}

// Move pending position by delta chunks
function movePendingBy(delta) {
  if (totalChunks <= 0) return;
  
  const base = pendingChunk !== null ? pendingChunk : currentChunk;
  pendingChunk = Math.max(0, Math.min(totalChunks - 1, base + delta));
  
  // Update visual
  setSeekPosition(chunkToPercent(pendingChunk));
  chunkCurrentEl.textContent = pendingChunk;
}

// ============ CLICK HANDLERS (Queue skip) ============

seekBackBtn.addEventListener('click', (e) => {
  if (seekBackBtn.disabled) return;
  // Single click = immediate skip back 1 chunk
  if (!isHolding) {
    console.log('[Popup] seekBackBtn click sending seek');
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'seekToChunk', chunkIndex: Math.max(0, currentChunk - 1) });
  }
});

seekForwardBtn.addEventListener('click', (e) => {
  if (seekForwardBtn.disabled) return;
  // Single click = immediate skip forward 1 chunk
  if (!isHolding) {
    console.log('[Popup] seekForwardBtn click sending seek');
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'seekToChunk', chunkIndex: Math.min(totalChunks - 1, currentChunk + 1) });
  }
});

// ============ HOLD HANDLERS (Auto-move) ============

function startHold(direction) {
  if (totalChunks <= 0) return;
  
  isHolding = true;
  pendingChunk = currentChunk;
  
  // Move immediately once
  movePendingBy(direction);
  
  // Then continue moving every 150ms while held
  holdInterval = setInterval(() => {
    movePendingBy(direction);
  }, 150);
}

function stopHold() {
  if (holdInterval) {
    clearInterval(holdInterval);
    holdInterval = null;
  }
  
  if (isHolding) {
    isHolding = false;
    commitSeek();
  }
}

// Mouse events for hold
seekBackBtn.addEventListener('mousedown', (e) => {
  if (seekBackBtn.disabled) return;
  e.preventDefault();
  startHold(-1);
});

seekForwardBtn.addEventListener('mousedown', (e) => {
  if (seekForwardBtn.disabled) return;
  e.preventDefault();
  startHold(+1);
});

// Stop hold on mouseup/mouseleave (on document to catch all cases)
document.addEventListener('mouseup', stopHold);
seekBackBtn.addEventListener('mouseleave', stopHold);
seekForwardBtn.addEventListener('mouseleave', stopHold);

// ============ DRAG HANDLE ============

seekHandle.addEventListener('mousedown', (e) => {
  if (totalChunks <= 0) return;
  e.preventDefault();
  e.stopPropagation();  // Prevent mousedown from bubbling to track
  isDragging = true;
  pendingChunk = currentChunk;
  seekHandle.style.cursor = 'grabbing';
});

// Prevent click event from bubbling to track (separate from mousedown)
seekHandle.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  
  const rect = seekTrack.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const percent = (x / rect.width) * 100;
  
  pendingChunk = percentToChunk(percent);
  setSeekPosition(chunkToPercent(pendingChunk));
  chunkCurrentEl.textContent = pendingChunk;
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    seekHandle.style.cursor = 'grab';
    commitSeek();
  }
});

// ============ CLICK ON TRACK ============

let lastSeekClickTime = 0;
let lastSeekChunk = -1;

seekTrack.addEventListener('click', (e) => {
  console.log('[Popup] seekTrack click event fired, isDragging:', isDragging);
  if (totalChunks <= 0) return;
  if (isDragging) return; // Don't trigger on drag end
  
  const rect = seekTrack.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const percent = (x / rect.width) * 100;
  
  const targetChunk = percentToChunk(percent);
  
  // Prevent duplicate clicks to the same chunk within 100ms
  const now = Date.now();
  if (targetChunk === lastSeekChunk && now - lastSeekClickTime < 100) {
    console.log('[Popup] Ignoring duplicate seek click to chunk', targetChunk);
    return;
  }
  lastSeekClickTime = now;
  lastSeekChunk = targetChunk;
  
  console.log('[Popup] seekTrack click sending seek to chunk:', targetChunk);
  console.trace('[Popup] seekTrack click call stack');
  
  // Update visual immediately
  setSeekPosition(chunkToPercent(targetChunk));
  chunkCurrentEl.textContent = targetChunk;
  
  // Seek to that chunk
  chrome.runtime.sendMessage({ 
    target: 'offscreen', 
    type: 'seekToChunk', 
    chunkIndex: targetChunk 
  });
});

// ============ HELPERS ============

function showStatus(type, message) {
  currentStatusType = type;
  currentStatusMessage = message;
  
  const statusTextEl = document.getElementById('status-text');
  const backendBadgeEl = document.getElementById('backend-badge');
  
  statusEl.className = `status ${type}`;
  statusTextEl.textContent = message;
  
  // Show backend badge if available (except for loading/error states)
  if (currentBackend && type !== 'loading' && type !== 'error') {
    const displayName = currentBackend === 'webgpu' ? '⚡ WebGPU' : '🔧 WASM (CPU)';
    backendBadgeEl.textContent = displayName;
    backendBadgeEl.className = `backend-badge ${currentBackend}`;
  } else {
    backendBadgeEl.className = 'backend-badge hidden';
  }
}
