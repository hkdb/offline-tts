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

// Background service worker

let offscreenDocumentReady = false;
let creatingOffscreenDocument = false;
let isPlaying = false;
let ttsModelReady = false;  // Track if TTS models are actually loaded

// Badge animation state
let badgeAnimationInterval = null;

function startBufferingAnimation() {
  stopBadgeAnimation();
  
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  
  chrome.action.setBadgeBackgroundColor({ color: '#FFA500' }); // Orange
  chrome.action.setBadgeText({ text: frames[0] });
  
  badgeAnimationInterval = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    chrome.action.setBadgeText({ text: frames[frameIndex] });
  }, 120);
}

function setPlayingBadge() {
  stopBadgeAnimation();
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' }); // Light Green
  chrome.action.setBadgeText({ text: '♪' });
}

function setPausedBadge() {
  stopBadgeAnimation();
  chrome.action.setBadgeBackgroundColor({ color: '#FFA500' }); // Orange
  chrome.action.setBadgeText({ text: '⏸' });
}

function stopBadgeAnimation() {
  if (badgeAnimationInterval) {
    clearInterval(badgeAnimationInterval);
    badgeAnimationInterval = null;
  }
}

function clearBadge() {
  stopBadgeAnimation();
  chrome.action.setBadgeText({ text: '' });
}

// Create offscreen document for TTS processing
async function setupOffscreenDocument() {
  // Prevent race condition - don't create if already creating
  if (creatingOffscreenDocument) {
    // Wait for ongoing creation to complete
    while (creatingOffscreenDocument) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return;
  }
  
  try {
    // If already marked as ready, trust that unless we're debugging
    if (offscreenDocumentReady && !creatingOffscreenDocument) {
      console.log('[Background] Offscreen document ready (fast path)');
      return;
    }
    
    // Always check if offscreen document actually exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });

    if (existingContexts.length > 0) {
      console.log('[Background] Offscreen document already exists');
      offscreenDocumentReady = true;
      return;
    }

    // Document doesn't exist, create it
    offscreenDocumentReady = false;
    ttsModelReady = false;  // Reset model status when creating new document
    chrome.storage.local.set({ modelStatus: 'loading' });  // Clear stale storage
    creatingOffscreenDocument = true;
    console.log('[Background] Creating offscreen document...');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'TTS synthesis and audio playback'
    });
    
    console.log('[Background] Offscreen document created');
    offscreenDocumentReady = true;
  } catch (error) {
    // Ignore "already exists" error
    if (error.message?.includes('single offscreen document')) {
      console.log('[Background] Offscreen document already exists (caught)');
      offscreenDocumentReady = true;
    } else {
      console.error('[Background] Failed to create offscreen document:', error);
    }
  } finally {
    creatingOffscreenDocument = false;
  }
}

/**
 * Wait for TTS models to be loaded and ready
 * Checks storage status and polls until ready or timeout
 * @param {number} timeoutMs - Maximum time to wait in milliseconds (default: 60000)
 * @returns {Promise<boolean>} True if ready, false if timeout or error
 */
async function waitForTTSReady(timeoutMs = 60000) {
  // First ensure offscreen document exists
  await setupOffscreenDocument();
  
  // If we just created/are creating an offscreen document, don't trust cache
  if (creatingOffscreenDocument) {
    console.log('[Background] Offscreen document being created, waiting...');
    // Wait for creation to complete
    let attempts = 0;
    while (creatingOffscreenDocument && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
  }
  
  // Check cached status (but verify with storage to avoid stale data)
  if (ttsModelReady) {
    // Double-check storage to make sure it's not stale
    const { modelStatus } = await chrome.storage.local.get(['modelStatus']);
    if (modelStatus === 'ready') {
      console.log('[Background] TTS already ready (cached + verified)');
      return true;
    } else {
      // Cache was stale, clear it
      console.log('[Background] Cache was stale, clearing');
      ttsModelReady = false;
    }
  }
  
  // Wait for model to load with progress updates
  console.log('[Background] Waiting for TTS models to load...');
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    // Check storage status
    const { modelStatus: status } = await chrome.storage.local.get(['modelStatus']);
    
    if (status === 'ready') {
      ttsModelReady = true;
      console.log('[Background] TTS models loaded successfully');
      return true;
    }
    
    if (status === 'error') {
      console.error('[Background] TTS model loading failed');
      return false;
    }
    
    // Wait before checking again
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  console.error('[Background] Timeout waiting for TTS models');
  return false;
}

// Setup offscreen document on service worker startup
setupOffscreenDocument();

// Also setup on browser startup
chrome.runtime.onStartup.addListener(() => {
  ttsModelReady = false;  // Reset on browser startup
  setupOffscreenDocument();
});

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] Extension installed/updated');
  // Create context menu
  chrome.contextMenus.create({
    id: 'read-selection',
    title: 'Read with OfflineTTS',
    contexts: ['selection']
  });
  
  // Set default settings
  chrome.storage.local.set({
    voice: 'M1',
    speed: 1.0,
    modelStatus: 'loading',
    playbackStatus: 'stopped'
  });
  
  ttsModelReady = false;
  setupOffscreenDocument();
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'read-selection') {
    console.log('[Background] Context menu: Read selection');
    const settings = await chrome.storage.local.get(['voice', 'speed']);
    
    // Show loading status immediately
    notifyPopup('playbackStatus', { status: 'buffering' });
    chrome.storage.local.set({ playbackStatus: 'buffering' });
    
    await speak(
      info.selectionText,
      settings.voice || 'M1',
      settings.speed || 1.0
    );
  }
});

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages targeted at offscreen document
  if (message.target === 'offscreen') {
    return false;
  }
  
  if (message.type === 'readPage') {
    readPage(message.tabId, message.voice, message.speed);
    return true;
  } else if (message.type === 'stopReading') {
    stopReading();
    return true;
  } else if (message.type === 'pauseReading') {
    pauseReading();
    return true;
  } else if (message.type === 'resumeReading') {
    resumeReading();
    return true;
  } else if (message.type === 'speak') {
    speak(message.text, message.voice, message.speed);
    return true;
  }
  
  return false;
});

/**
 * Extract and read text from a page
 * Handles both regular pages and PDFs
 * @param {number} tabId - Tab ID to extract text from
 * @param {string} voice - Voice ID
 * @param {number} speed - Speed multiplier
 */
async function readPage(tabId, voice, speed) {
  try {
    // Extract text from the page (with retry for content script not ready)
    let response = null;
    let retries = 5;
    
    while (retries > 0 && !response) {
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: 'extractText' });
      } catch (err) {
        // Content script not ready yet
        console.log('[Background] Content script not ready, retrying...', retries);
        retries--;
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }
    
    if (!response) {
      notifyPopup('error', 'No response from page. Try reloading the page.');
      return;
    }
    
    // Check if it's a PDF - extract in offscreen document instead
    if (response.isPDF) {
      console.log('[Background] PDF detected, extracting via offscreen document');
      await setupOffscreenDocument();
      
      const pdfResponse = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'extractPDF',
        url: response.url
      });
      
      if (!pdfResponse || !pdfResponse.success) {
        const errorMsg = pdfResponse?.error || 'Failed to extract PDF text';
        
        // Check if this was a cancellation (expected, not an error)
        if (errorMsg.includes('cancelled') || errorMsg.includes('superseded')) {
          console.log('[Background] PDF extraction cancelled (expected):', errorMsg);
          // Don't show error to user - silently return, let the newer extraction continue
          return;
        }
        
        notifyPopup('error', errorMsg);
        return;
      }
      
      speak(pdfResponse.text, voice, speed, tabId);
      return;
    }
    
    if (!response.text) {
      notifyPopup('error', 'No text found on page');
      return;
    }
    
    // DEBUG: Log text received from content.js
    console.log('[Background] DEBUG text from content.js:', response.text.substring(0, 500).replace(/\n/g, '\\n'));
    
    speak(response.text, voice, speed, tabId);
  } catch (error) {
    console.error('Error reading page:', error);
    notifyPopup('error', error.message);
  }
}

// Debounce state for speak function
let lastSpeakCall = 0;
const SPEAK_DEBOUNCE_MS = 300;

/**
 * Speak the given text using TTS
 * Stops any current playback, waits for TTS engine to be ready, sends to offscreen document
 * @param {string} text - Text to speak
 * @param {string} voice - Voice ID (M1, M2, F1, F2)
 * @param {number} speed - Speed multiplier
 * @param {number|null} tabId - Tab ID for highlighting (optional)
 */
async function speak(text, voice, speed, tabId = null) {
  // Debounce rapid clicks (only when already playing)
  const now = Date.now();
  if (isPlaying && now - lastSpeakCall < SPEAK_DEBOUNCE_MS) {
    console.log('[Background] Ignoring rapid click (debounced)');
    return;
  }
  lastSpeakCall = now;
  
  if (!text || text.trim().length === 0) {
    notifyPopup('error', 'No text to read');
    return;
  }
  
  // Stop any current playback first (single session only)
  if (isPlaying) {
    console.log('[Background] Stopping current playback before starting new');
    stopReading();
    // Small delay to let stop propagate
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Set the tab ID for highlighting AFTER stopReading() clears the old one
  if (tabId) {
    currentReadingTabId = tabId;
  }
  
  // Update state - mark as buffering until audio actually starts
  isPlaying = true;
  chrome.storage.local.set({ playbackStatus: 'buffering' });
  notifyPopup('playbackStatus', { status: 'buffering' });
  startBufferingAnimation();
  
  // Wait for TTS models to be ready (this is the key fix!)
  console.log('[Background] Checking if TTS is ready...');
  const ready = await waitForTTSReady(60000);  // 60 second timeout
  
  if (!ready) {
    console.error('[Background] TTS not ready, cannot speak');
    isPlaying = false;
    chrome.storage.local.set({ playbackStatus: 'stopped' });
    notifyPopup('error', 'TTS models failed to load. Please reload the extension.');
    notifyPopup('playbackStatus', { status: 'stopped' });
    clearBadge();
    return;
  }
  
  console.log('[Background] Sending TTS request to offscreen document');
  
  // DEBUG: Log text being sent to offscreen
  console.log('[Background] DEBUG text to offscreen:', text.substring(0, 500).replace(/\n/g, '\\n'));
  
  // Send to offscreen document for TTS processing
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'tts',
    text,
    voice,
    speed
  });
}

function stopReading() {
  console.log('[Background] Stopping playback');
  isPlaying = false;
  isPaused = false;
  currentChunk = 0;
  totalChunks = 0;
  chrome.storage.local.set({ playbackStatus: 'stopped' });
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopTTS' });
  notifyPopup('playbackStatus', { status: 'stopped' });
  clearBadge();
  // Clear highlighting
  if (currentReadingTabId) {
    chrome.tabs.sendMessage(currentReadingTabId, { type: 'clearHighlight' }).catch(() => {});
    currentReadingTabId = null;
  }
}

let isPaused = false;

function pauseReading() {
  console.log('[Background] Pausing playback');
  isPaused = true;
  chrome.storage.local.set({ playbackStatus: 'paused' });
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'pauseTTS' });
  notifyPopup('playbackStatus', { status: 'paused' });
  setPausedBadge();
}

function resumeReading() {
  console.log('[Background] Resuming playback');
  isPaused = false;
  chrome.storage.local.set({ playbackStatus: 'playing' });
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'resumeTTS' });
  notifyPopup('playbackStatus', { status: 'playing' });
  setPlayingBadge();
}

function notifyPopup(type, data) {
  // Handle string arguments (for error messages) vs object arguments
  const payload = typeof data === 'string' ? { type, message: data } : { type, ...data };
  chrome.runtime.sendMessage(payload).catch(() => {
    // Popup might be closed, ignore error
  });
}

// Track current tab for highlighting
let currentReadingTabId = null;

// Track current playback position for keyboard shortcuts
let currentChunk = 0;
let totalChunks = 0;

// Listen for messages from offscreen document
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'modelStatus') {
    // Update cached status
    if (message.status === 'ready') {
      ttsModelReady = true;
      console.log('[Background] TTS model status: ready');
      // Also save backend if provided
      if (message.backend) {
        chrome.storage.local.set({ backend: message.backend });
        console.log('[Background] TTS backend:', message.backend);
      }
    } else if (message.status === 'error') {
      ttsModelReady = false;
      console.error('[Background] TTS model status: error -', message.message);
    } else {
      console.log('[Background] TTS model status:', message.status, message.message || '');
    }
    // Save to storage so popup can read it when opened
    chrome.storage.local.set({ modelStatus: message.status });
    notifyPopup('modelStatus', message);
  } else if (message.type === 'backendStatus') {
    // Handle dedicated backend status from offscreen
    console.log('[Background] Backend status:', message.backend);
    chrome.storage.local.set({ backend: message.backend });
    notifyPopup('backendStatus', { backend: message.backend });
  } else if (message.type === 'playbackComplete') {
    console.log('[Background] Playback complete');
    isPlaying = false;
    isPaused = false;
    chrome.storage.local.set({ playbackStatus: 'stopped' });
    notifyPopup('playbackStatus', { status: 'stopped' });
    clearBadge();
    // Clear highlighting
    if (currentReadingTabId) {
      chrome.tabs.sendMessage(currentReadingTabId, { type: 'clearHighlight' }).catch(() => {});
      currentReadingTabId = null;
    }
  } else if (message.type === 'playbackStatus') {
    // Relay status updates from offscreen to popup
    if (message.status === 'buffering') {
      chrome.storage.local.set({ playbackStatus: 'buffering' });
      startBufferingAnimation();
    } else if (message.status === 'paused') {
      isPaused = true;
      chrome.storage.local.set({ playbackStatus: 'paused' });
      setPausedBadge();
    } else if (message.status === 'playing') {
      isPaused = false;
      isPlaying = true;
      chrome.storage.local.set({ playbackStatus: 'playing' });
      setPlayingBadge();
    }
    notifyPopup('playbackStatus', message);
  } else if (message.type === 'chunkPlaying') {
    // Relay chunk info to content script for highlighting
    if (currentReadingTabId) {
      chrome.tabs.sendMessage(currentReadingTabId, {
        type: 'highlightChunk',
        chunkText: message.chunkText,
        chunkIndex: message.chunkIndex,
        totalChunks: message.totalChunks
      }).catch(() => {});
    }
  } else if (message.type === 'chunkPreload') {
    // Pre-send next chunk's highlight info so content script can prepare it
    if (currentReadingTabId) {
      chrome.tabs.sendMessage(currentReadingTabId, {
        type: 'preloadHighlight',
        chunkText: message.chunkText,
        chunkIndex: message.chunkIndex
      }).catch(() => {});
    }
  } else if (message.type === 'progressUpdate') {
    // Track position for keyboard shortcuts
    currentChunk = message.currentChunk;
    totalChunks = message.totalChunks;
    
    // Relay progress updates to popup for seek bar
    notifyPopup('progressUpdate', {
      currentChunk: message.currentChunk,
      totalChunks: message.totalChunks
    });
  }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Background] Command received:', command);
  
  switch (command) {
    case 'play-pause':
      if (isPlaying && !isPaused) {
        pauseReading();
      } else if (isPaused) {
        resumeReading();
      } else {
        // Not playing, start reading current page
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          const settings = await chrome.storage.local.get(['voice', 'speed']);
          readPage(tab.id, settings.voice || 'M1', settings.speed || 1.0);
        }
      }
      break;
      
    case 'stop':
      if (isPlaying || isPaused) {
        stopReading();
      }
      break;
      
    case 'skip-forward':
      if (isPlaying || isPaused) {
        const nextChunk = Math.min(totalChunks - 1, currentChunk + 1);
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'seekToChunk', chunkIndex: nextChunk });
      }
      break;
      
    case 'skip-back':
      if (isPlaying || isPaused) {
        const prevChunk = Math.max(0, currentChunk - 1);
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'seekToChunk', chunkIndex: prevChunk });
      }
      break;
  }
});
