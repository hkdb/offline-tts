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
//
// Playback state is kept in chrome.storage.session (not in globals) because Chrome
// stops idle service workers; the popup renders from the same storage keys:
//   playbackStatus ('stopped' | 'buffering' | 'playing' | 'paused'), currentChunk,
//   totalChunks, readingTabId, resumeSession ({ text, voice }), modelStatus, modelError, backend

const OFFSCREEN_URL = 'offscreen.html';
const DEFAULT_SETTINGS = { voice: 'M1', speed: 1.0 };
const ACTIVE_STATUSES = ['buffering', 'playing', 'paused'];

// ==== BADGE ====

let badgeAnimationInterval = null;

function startBufferingAnimation() {
  if (badgeAnimationInterval) return;
  
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  
  chrome.action.setBadgeBackgroundColor({ color: '#FFA500' }); // Orange
  chrome.action.setBadgeText({ text: frames[0] });
  
  badgeAnimationInterval = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    chrome.action.setBadgeText({ text: frames[frameIndex] });
  }, 120);
}

function stopBadgeAnimation() {
  if (badgeAnimationInterval) {
    clearInterval(badgeAnimationInterval);
    badgeAnimationInterval = null;
  }
}

function updateBadge(status) {
  if (status === 'buffering') {
    startBufferingAnimation();
    return;
  }
  
  stopBadgeAnimation();
  if (status === 'playing') {
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' }); // Light Green
    chrome.action.setBadgeText({ text: '♪' });
  } else if (status === 'paused') {
    chrome.action.setBadgeBackgroundColor({ color: '#FFA500' }); // Orange
    chrome.action.setBadgeText({ text: '⏸' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ==== STATE ====

async function getState(keys) {
  return chrome.storage.session.get(keys);
}

async function setPlaybackStatus(status) {
  await chrome.storage.session.set({ playbackStatus: status });
  updateBadge(status);
}

// ==== OFFSCREEN DOCUMENT ====

let creatingOffscreenDocument = null;  // Promise while a createDocument call is in flight

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

/**
 * Create the offscreen document if it doesn't exist
 * Always checks the real document list - Chrome may have closed it since we last looked
 */
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = (async () => {
      console.log('[Background] Creating offscreen document...');
      await chrome.storage.session.set({ modelStatus: 'loading', modelError: null });
      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          // AUDIO_PLAYBACK alone gets the document closed after 30s of silence (e.g. while paused).
          // ONNX Runtime runs multi-threaded inference in web workers, so WORKERS also applies
          reasons: ['AUDIO_PLAYBACK', 'WORKERS'],
          justification: 'TTS synthesis (ONNX Runtime web workers) and audio playback'
        });
        console.log('[Background] Offscreen document created');
      } catch (error) {
        // Ignore "already exists" error
        if (!error.message?.includes('single offscreen document')) {
          throw error;
        }
      }
    })().finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  
  await creatingOffscreenDocument;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    console.log('[Background] Closing idle offscreen document');
    await chrome.offscreen.closeDocument();
  }
  await chrome.storage.session.set({ modelStatus: 'unloaded' });
}

/**
 * Send a message to the offscreen document
 * @returns {Promise<any>} The response, or undefined if the document isn't there
 */
function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message }).catch(() => undefined);
}

/**
 * Wait for TTS models to be loaded and ready
 * Asks the offscreen document directly so a closed document can't leave stale "ready" state
 * @param {number} timeoutMs - Maximum time to wait in milliseconds (default: 60000)
 * @returns {Promise<boolean>} True if ready, false if timeout or error
 */
async function waitForTTSReady(timeoutMs = 60000) {
  try {
    await ensureOffscreenDocument();
  } catch (error) {
    console.error('[Background] Failed to create offscreen document:', error);
    return false;
  }
  
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const status = await sendToOffscreen({ type: 'getStatus' });
    
    if (status?.ready) return true;
    if (status?.error) {
      console.error('[Background] TTS model loading failed:', status.error);
      return false;
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  console.error('[Background] Timeout waiting for TTS models');
  return false;
}

async function hasActiveSession() {
  const status = await sendToOffscreen({ type: 'getStatus' });
  return !!status?.hasSession;
}

// ==== INSTALL / CONTEXT MENU ====

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] Extension installed/updated');
  
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'read-selection',
    title: 'Read with OfflineTTS',
    contexts: ['selection']
  });
  
  // Only fill in missing settings so updates keep the user's choices
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => stored[key] === undefined)
  );
  if (Object.keys(missing).length > 0) {
    await chrome.storage.local.set(missing);
  }
  
  // State that older versions kept in local storage now lives in session storage
  await chrome.storage.local.remove(['modelStatus', 'playbackStatus', 'backend']);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'read-selection') {
    console.log('[Background] Context menu: Read selection');
    const settings = await chrome.storage.local.get(['voice', 'speed']);
    speak(
      info.selectionText,
      settings.voice || DEFAULT_SETTINGS.voice,
      settings.speed || DEFAULT_SETTINGS.speed,
      tab?.id ?? null
    );
  }
});

// ==== MESSAGES ====

// Handle messages from popup, content scripts and the offscreen document
chrome.runtime.onMessage.addListener((message) => {
  // Ignore messages targeted at offscreen document
  if (message.target === 'offscreen') {
    return false;
  }
  
  switch (message.type) {
    // From popup
    case 'warmup':
      // Start loading models while the user looks at the popup
      ensureOffscreenDocument().catch(error => {
        console.error('[Background] Failed to create offscreen document:', error);
      });
      break;
    case 'readPage':
      readPage(message.tabId, message.voice, message.speed);
      break;
    case 'stopReading':
      stopReading();
      break;
    case 'pauseReading':
      pauseReading();
      break;
    case 'resumeReading':
      resumeReading();
      break;
    case 'seek':
      seekToChunk(message.chunkIndex);
      break;
    case 'skip':
      skipChunks(message.delta);
      break;
    case 'setSpeed':
      sendToOffscreen({ type: 'updateSpeed', speed: message.speed });
      break;
      
    // From offscreen document
    case 'modelStatus':
      handleModelStatus(message);
      break;
    case 'backendStatus':
      chrome.storage.session.set({ backend: message.backend });
      break;
    case 'playbackStatus':
      handleOffscreenPlaybackStatus(message.status);
      break;
    case 'progressUpdate':
      chrome.storage.session.set({
        currentChunk: message.currentChunk,
        totalChunks: message.totalChunks
      });
      break;
    case 'chunkPlaying':
      sendToReadingTab({
        type: 'highlightChunk',
        chunkText: message.chunkText,
        chunkIndex: message.chunkIndex,
        totalChunks: message.totalChunks
      });
      break;
    case 'chunkPreload':
      // Pre-send next chunk's highlight info so content script can prepare it
      sendToReadingTab({
        type: 'preloadHighlight',
        chunkText: message.chunkText,
        chunkIndex: message.chunkIndex
      });
      break;
    case 'playbackComplete':
      console.log('[Background] Playback complete');
      finishPlayback();
      break;
    case 'playbackError':
      console.error('[Background] Playback error:', message.message);
      // Popup clears errors when playbackStatus changes, so report after the reset lands
      finishPlayback().then(() => notifyPopup('error', message.message));
      break;
    case 'offscreenIdle':
      handleOffscreenIdle();
      break;
  }
  
  return false;
});

function handleModelStatus(message) {
  if (message.status === 'ready') {
    console.log('[Background] TTS model status: ready', message.backend || '');
    chrome.storage.session.set({ modelStatus: 'ready', modelError: null, backend: message.backend });
  } else if (message.status === 'error') {
    console.error('[Background] TTS model status: error -', message.message);
    chrome.storage.session.set({ modelStatus: 'error', modelError: message.message });
  } else {
    console.log('[Background] TTS model status:', message.status, message.message || '');
    chrome.storage.session.set({ modelStatus: message.status });
  }
}

async function handleOffscreenPlaybackStatus(status) {
  // Ignore late updates from a session that was already stopped
  const { playbackStatus } = await getState('playbackStatus');
  if (!ACTIVE_STATUSES.includes(playbackStatus)) return;
  await setPlaybackStatus(status);
}

async function handleOffscreenIdle() {
  // A new read may have started after the offscreen document sent this
  const { playbackStatus } = await getState('playbackStatus');
  if (playbackStatus === 'buffering' || playbackStatus === 'playing') return;
  await closeOffscreenDocument();
}

async function sendToReadingTab(message) {
  const { readingTabId } = await getState('readingTabId');
  if (readingTabId) {
    chrome.tabs.sendMessage(readingTabId, message).catch(() => {});
  }
}

function notifyPopup(type, data) {
  // Handle string arguments (for error messages) vs object arguments
  const payload = typeof data === 'string' ? { type, message: data } : { type, ...data };
  chrome.runtime.sendMessage(payload).catch(() => {
    // Popup might be closed, ignore error
  });
}

// ==== READING ====

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
      await ensureOffscreenDocument();
      
      const pdfResponse = await sendToOffscreen({
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
    
    speak(response.text, voice, speed, tabId);
  } catch (error) {
    console.error('Error reading page:', error);
    notifyPopup('error', error.message);
  }
}

// Incremented by every speak/stop so a speak still waiting on model loading can tell it was superseded
let speakRequestId = 0;

/**
 * Speak the given text using TTS
 * Stops any current playback, waits for TTS engine to be ready, sends to offscreen document
 * @param {string} text - Text to speak
 * @param {string} voice - Voice ID (M1, M2, F1, F2)
 * @param {number} speed - Speed multiplier
 * @param {number|null} tabId - Tab ID for highlighting (optional)
 * @param {number} startChunk - Chunk index to start from (optional)
 */
async function speak(text, voice, speed, tabId = null, startChunk = 0) {
  if (!text || text.trim().length === 0) {
    notifyPopup('error', 'No text to read');
    return;
  }
  
  // Single session only
  await stopReading();
  const requestId = ++speakRequestId;
  
  // Saved so reading can resume at the same position if Chrome closes the offscreen document
  await chrome.storage.session.set({
    readingTabId: tabId,
    resumeSession: { text, voice },
    currentChunk: startChunk,
    totalChunks: 0
  }).catch(error => {
    console.warn('[Background] Could not save resume state:', error.message);
  });
  await setPlaybackStatus('buffering');
  
  console.log('[Background] Checking if TTS is ready...');
  const ready = await waitForTTSReady();
  
  if (requestId !== speakRequestId) {
    console.log('[Background] Speak request superseded while loading');
    return;
  }
  
  if (!ready) {
    console.error('[Background] TTS not ready, cannot speak');
    // Close the failed document so the next attempt starts fresh
    await closeOffscreenDocument().catch(() => {});
    await finishPlayback();
    notifyPopup('error', 'TTS models failed to load. Please reload the extension.');
    return;
  }
  
  console.log('[Background] Sending TTS request to offscreen document');
  const { playbackStatus } = await getState('playbackStatus');
  sendToOffscreen({ type: 'tts', text, voice, speed, startChunk });
  if (playbackStatus === 'paused') {
    // User paused while models were loading
    sendToOffscreen({ type: 'pauseTTS' });
  }
}

async function stopReading() {
  console.log('[Background] Stopping playback');
  speakRequestId++;
  sendToOffscreen({ type: 'stopTTS' });
  await finishPlayback();
}

/**
 * Reset playback state and clear highlighting after stop, completion or error
 */
async function finishPlayback() {
  const { readingTabId } = await getState('readingTabId');
  if (readingTabId) {
    chrome.tabs.sendMessage(readingTabId, { type: 'clearHighlight' }).catch(() => {});
  }
  await chrome.storage.session.set({ readingTabId: null, currentChunk: 0, totalChunks: 0 });
  await chrome.storage.session.remove('resumeSession');
  await setPlaybackStatus('stopped');
}

async function pauseReading() {
  const { playbackStatus } = await getState('playbackStatus');
  if (playbackStatus !== 'playing' && playbackStatus !== 'buffering') return;
  
  console.log('[Background] Pausing playback');
  await setPlaybackStatus('paused');
  sendToOffscreen({ type: 'pauseTTS' });
}

async function resumeReading() {
  const { playbackStatus, currentChunk } = await getState(['playbackStatus', 'currentChunk']);
  if (playbackStatus !== 'paused') return;
  
  console.log('[Background] Resuming playback');
  if (await hasActiveSession()) {
    sendToOffscreen({ type: 'resumeTTS' });
  } else {
    await restartFromSavedSession(currentChunk || 0);
  }
}

async function seekToChunk(chunkIndex) {
  const { playbackStatus } = await getState('playbackStatus');
  if (!ACTIVE_STATUSES.includes(playbackStatus)) return;
  
  if (await hasActiveSession()) {
    sendToOffscreen({ type: 'seekToChunk', chunkIndex });
  } else {
    await restartFromSavedSession(chunkIndex);
  }
}

async function skipChunks(delta) {
  const { playbackStatus, currentChunk } = await getState(['playbackStatus', 'currentChunk']);
  if (!ACTIVE_STATUSES.includes(playbackStatus)) return;
  
  if (await hasActiveSession()) {
    sendToOffscreen({ type: 'skip', delta });
  } else {
    await restartFromSavedSession((currentChunk || 0) + delta);
  }
}

/**
 * The offscreen document was closed (idle while paused, or by Chrome) -
 * start a new session at the saved position
 */
async function restartFromSavedSession(chunkIndex) {
  const { resumeSession, readingTabId } = await getState(['resumeSession', 'readingTabId']);
  if (!resumeSession) {
    await finishPlayback();
    return;
  }
  
  console.log('[Background] Offscreen session gone, restarting at chunk', chunkIndex);
  const { speed } = await chrome.storage.local.get('speed');
  speak(resumeSession.text, resumeSession.voice, speed || DEFAULT_SETTINGS.speed, readingTabId, Math.max(0, chunkIndex));
}

// ==== KEYBOARD SHORTCUTS ====

chrome.commands.onCommand.addListener(async (command) => {
  console.log('[Background] Command received:', command);
  const { playbackStatus } = await getState('playbackStatus');
  
  switch (command) {
    case 'play-pause':
      if (playbackStatus === 'playing' || playbackStatus === 'buffering') {
        pauseReading();
      } else if (playbackStatus === 'paused') {
        resumeReading();
      } else {
        // Not playing, start reading current page
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          const settings = await chrome.storage.local.get(['voice', 'speed']);
          readPage(tab.id, settings.voice || DEFAULT_SETTINGS.voice, settings.speed || DEFAULT_SETTINGS.speed);
        }
      }
      break;
      
    case 'stop':
      if (ACTIVE_STATUSES.includes(playbackStatus)) {
        stopReading();
      }
      break;
      
    case 'skip-forward':
      skipChunks(1);
      break;
      
    case 'skip-back':
      skipChunks(-1);
      break;
  }
});

// Restore the badge after the service worker restarts
getState('playbackStatus').then(({ playbackStatus }) => updateBadge(playbackStatus));
