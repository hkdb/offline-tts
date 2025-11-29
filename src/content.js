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

// Content script for extracting text from web pages

// Content extraction constants
const MIN_HIGHLIGHT_TEXT_LENGTH = 10;  // Minimum text length for highlighting
const MIN_CONTENT_LENGTH = 200;         // Minimum extracted content before fallback to textContent
const MIN_SEARCH_PHRASE_LENGTH = 5;    // Minimum search phrase length for element matching
const SEARCH_PHRASE_WORDS = 8;         // Number of words to use for primary search
const FALLBACK_SEARCH_WORDS = 5;       // Number of words for fallback search

// Highlighting state
let highlightedElement = null;
let highlightStyle = null;
let preloadedHighlight = null; // { chunkIndex, element } - pre-found element for next chunk

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'extractText') {
    // Handle text extraction (may return PDF marker)
    extractPageText().then(result => {
      // Check if it's a PDF marker
      if (result && result.isPDF) {
        sendResponse({ isPDF: true, url: result.url });
      } else {
        sendResponse({ text: result });
      }
    }).catch(err => {
      console.error('Text extraction error:', err);
      sendResponse({ text: '', error: err.message });
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'extractSelection') {
    const text = window.getSelection().toString().trim();
    sendResponse({ text });
    return true;
  } else if (message.type === 'highlightChunk') {
    highlightChunk(message.chunkText, message.chunkIndex);
    return false;
  } else if (message.type === 'preloadHighlight') {
    preloadHighlight(message.chunkText, message.chunkIndex);
    return false;
  } else if (message.type === 'clearHighlight') {
    clearHighlight();
    return false;
  }
});

// Inject highlight styles
function injectHighlightStyles() {
  if (highlightStyle) return;
  
  highlightStyle = document.createElement('style');
  highlightStyle.textContent = `
    .offlinetts-highlight {
      background-color: rgba(255, 235, 59, 0.5) !important;
      border-radius: 3px;
      box-shadow: 0 0 0 2px rgba(255, 235, 59, 0.3);
      transition: background-color 0.3s ease;
    }
    @media (prefers-color-scheme: dark) {
      .offlinetts-highlight {
        background-color: rgba(255, 193, 7, 0.4) !important;
        box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.2);
      }
    }
  `;
  document.head.appendChild(highlightStyle);
}

// Highlight chunk - uses preloaded element if available
function highlightChunk(text, chunkIndex) {
  if (!text || text.length < MIN_HIGHLIGHT_TEXT_LENGTH) return;
  
  injectHighlightStyles();
  clearHighlight();
  
  // Check if we have a preloaded element for this chunk
  if (preloadedHighlight && preloadedHighlight.chunkIndex === chunkIndex && preloadedHighlight.element) {
    const el = preloadedHighlight.element;
    el.classList.add('offlinetts-highlight');
    highlightedElement = el;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    console.log('[OfflineTTS] Highlighted (preloaded):', el.tagName);
    preloadedHighlight = null;
    return;
  }
  
  // No preload, find element now
  const element = findElementForText(text);
  if (element) {
    element.classList.add('offlinetts-highlight');
    highlightedElement = element;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    console.log('[OfflineTTS] Highlighted:', element.tagName);
  }
}

// Preload highlight - find element for next chunk ahead of time
function preloadHighlight(text, chunkIndex) {
  if (!text || text.length < MIN_HIGHLIGHT_TEXT_LENGTH) {
    preloadedHighlight = null;
    return;
  }
  
  const element = findElementForText(text);
  if (element) {
    preloadedHighlight = { chunkIndex, element };
    console.log('[OfflineTTS] Preloaded highlight for chunk', chunkIndex, ':', element.tagName);
  } else {
    preloadedHighlight = null;
  }
}

/**
 * Find DOM element containing the given text for highlighting
 * Uses first 5-8 words for matching to balance speed and uniqueness
 * @param {string} text - Text to find in the DOM
 * @returns {Element|null} Matching DOM element or null if not found
 */
function findElementForText(text) {
  // Normalize whitespace
  const normalized = text.replace(/\s+/g, ' ').trim();
  const words = normalized.split(/\s+/);
  
  // Use first 8 words for matching - balances speed and uniqueness
  // Strip trailing punctuation so "Title." matches "Title" in DOM
  const searchPhrase = words.slice(0, SEARCH_PHRASE_WORDS).join(' ').replace(/[.!?]+$/, '');
  
  if (searchPhrase.length < MIN_SEARCH_PHRASE_LENGTH) {
    console.log('[OfflineTTS] Search phrase too short for highlighting:', searchPhrase);
    return null;
  }
  
  // Search in content elements (excluding div, article, section to avoid overly broad matches)
  const contentElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, span');
  
  for (const el of contentElements) {
    // Normalize element text for comparison
    const elText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    
    if (elText.includes(searchPhrase)) {
      return el;
    }
  }
  
  // Fallback: try with just first 5 words
  const shortPhrase = words.slice(0, FALLBACK_SEARCH_WORDS).join(' ');
  for (const el of contentElements) {
    const elText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    
    if (elText.includes(shortPhrase)) {
      console.log('[OfflineTTS] Found element (fallback 5 words):', el.tagName);
      return el;
    }
  }
  
  console.log('[OfflineTTS] No matching element found for:', searchPhrase);
  return null;
}

// Clear any existing highlight
function clearHighlight() {
  if (highlightedElement) {
    highlightedElement.classList.remove('offlinetts-highlight');
    highlightedElement = null;
  }
  // Clear preloaded highlight
  preloadedHighlight = null;
  // Also clear any other highlights that might be lingering
  document.querySelectorAll('.offlinetts-highlight').forEach(el => {
    el.classList.remove('offlinetts-highlight');
  });
}

/**
 * Extract readable text from current page
 * Uses simple algorithm - can be enhanced with Readability.js later
 */
async function extractPageText() {
  // Check if it's a PDF - signal to use offscreen document for extraction
  if (isPDFPage()) {
    // Return special marker so background knows to use offscreen PDF extraction
    return { isPDF: true, url: location.href };
  }
  
  // For regular web pages, extract main content
  return extractArticleText();
}

function isPDFPage() {
  // Check content type or URL
  const isPdfContentType = document.contentType === 'application/pdf';
  const isPdfUrl = location.pathname.toLowerCase().endsWith('.pdf');
  
  // Also check for PDF.js viewer (Chrome's built-in PDF viewer)
  const hasPdfEmbed = document.querySelector('embed[type="application/pdf"]') !== null;
  const hasPdfViewer = document.querySelector('pdf-viewer') !== null;
  
  return isPdfContentType || isPdfUrl || hasPdfEmbed || hasPdfViewer;
}

// PDF extraction is now handled by offscreen.js to avoid CSP issues

/**
 * Extract readable text from a web page
 * Uses site-specific selectors for popular sites, falls back to generic content extraction
 * Removes navigation, ads, comments, and other non-content elements
 * @returns {string} Extracted and cleaned text content
 */
function extractArticleText() {
  // First, extract the page title
  const title = extractPageTitle();
  
  // Site-specific selectors for popular websites
  const siteSelectors = {
    // Wikipedia
    'wikipedia.org': '#mw-content-text .mw-parser-output',
    'en.wikipedia.org': '#mw-content-text .mw-parser-output',
    // Medium
    'medium.com': 'article',
    // News sites
    'nytimes.com': 'article[data-testid="article-body"]',
    'theguardian.com': '#maincontent',
    'bbc.com': 'article',
    'bbc.co.uk': 'article',
    'cnn.com': '.article__content',
    'reuters.com': '[data-testid="article-body"]',
    'washingtonpost.com': '.article-body',
    // Tech sites
    'techcrunch.com': '.article-content',
    'arstechnica.com': '.article-content',
    'theverge.com': '.duet--article--article-body-component',
    // Blogs
    'substack.com': '.body',
    'dev.to': '#article-body',
    'hashnode.com': '.prose',
    // Reddit
    'reddit.com': '[data-test-id="post-content"]',
    // Documentation
    'docs.google.com': '.kix-page',
    'notion.so': '.notion-page-content',
    'github.com': '.markdown-body',
  };
  
  const hostname = window.location.hostname.replace('www.', '');
  let contentElement = null;
  
  // Try site-specific selector first
  for (const [site, selector] of Object.entries(siteSelectors)) {
    if (hostname.includes(site.replace('www.', ''))) {
      contentElement = document.querySelector(selector);
      if (contentElement) {
        console.log(`[OfflineTTS] Using site-specific selector for ${site}`);
        break;
      }
    }
  }
  
  // Fallback to generic selectors (in priority order)
  if (!contentElement) {
    const genericSelectors = [
      // High-level containers that include headers (for sites like Mintlify)
      '#content-area',
      '.content-area',
      // Semantic HTML5 elements
      'article',
      'main',
      '[role="main"]',
      // Common content classes/IDs
      '#content',
      '#main-content',
      '.content',
      '.main-content',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.post-body',
      '.article-body',
      // WordPress
      '.hentry',
      '.post',
      // Generic containers (less specific)
      '#primary',
      '.primary',
    ];
    
    for (const selector of genericSelectors) {
      contentElement = document.querySelector(selector);
      if (contentElement && contentElement.textContent.trim().length > 200) {
        console.log(`[OfflineTTS] Using generic selector: ${selector}`);
        break;
      }
      contentElement = null;
    }
  }
  
  // Last resort: use body
  if (!contentElement) {
    console.log('[OfflineTTS] Falling back to body');
    contentElement = document.body;
  }
  
  // Clone to avoid modifying the actual page
  const clone = contentElement.cloneNode(true);
  
  // Remove unwanted elements (expanded list)
  const unwantedSelectors = [
    // Scripts and styles
    'script', 'style', 'noscript', 'iframe',
    // Navigation and structure (but NOT header - it may contain page summaries)
    'nav', 'footer', 'aside',
    '[role="navigation"]', '[role="complementary"]', '[role="banner"]', '[role="contentinfo"]',
    // Hidden elements
    '[aria-hidden="true"]', '[hidden]', '.hidden', '.visually-hidden', '.sr-only',
    // Ads and promotions
    '.ad', '.ads', '.advertisement', '.advert', '[class*="advert"]',
    '.sponsored', '.promo', '.promotion',
    // Social and sharing
    '.social', '.share', '.sharing', '[class*="share"]',
    '.follow', '.subscribe',
    // Comments
    '#comments', '.comments', '.comment-section', '[class*="comment"]',
    // Related content
    '.related', '.recommended', '.more-stories', '.read-more', '.see-also',
    '[class*="related"]', '[class*="recommended"]',
    // Sidebars and widgets
    '.sidebar', '.widget', '.widgets',
    '#sidebar', '[class*="sidebar"]',
    // Menus
    '.menu', '.dropdown', '[class*="menu"]',
    // Forms
    'form', '.search', '[class*="search"]',
    // Wikipedia-specific
    '.mw-editsection', '.reference', '.reflist', '.references',
    '.navbox', '.infobox', '.sidebar', '.toc', '#toc',
    '.hatnote', '.mbox', '.ambox', '.dmbox', '.tmbox',
    '.portal', '.catlinks', '#catlinks',
    '.mw-headline-anchor',
    // Tables of contents
    '.table-of-contents', '.toc',
    // Footers and metadata
    '.meta', '.metadata', '.byline', '.author-info',
    '.tags', '.categories', '.breadcrumb',
    // Popups and modals
    '.modal', '.popup', '.overlay', '.tooltip',
    // Cookie notices
    '.cookie', '[class*="cookie"]', '[class*="consent"]',
  ];
  
  const unwanted = clone.querySelectorAll(unwantedSelectors.join(', '));
  unwanted.forEach(el => el.remove());
  
  // Remove specific unwanted elements from headers (buttons, breadcrumbs, etc.)
  const headerUnwanted = clone.querySelectorAll('header button, header .breadcrumb, header nav, header [class*="menu"]');
  headerUnwanted.forEach(el => el.remove());
  
  // Remove elements that are likely navigation based on link density
  const allDivs = clone.querySelectorAll('div, section, ul');
  allDivs.forEach(div => {
    const links = div.querySelectorAll('a');
    const text = div.textContent || '';
    const linkText = Array.from(links).map(a => a.textContent).join('');
    
    // If more than 50% of text is links, it's probably navigation
    if (text.length > 0 && linkText.length / text.length > 0.5 && links.length > 5) {
      div.remove();
    }
  });
  
  // Extract text from remaining paragraphs and headings for cleaner output
  const contentElements = clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, span');
  
  // Seed textParts with title (with period for natural pause) so duplicate detection catches title h1
  let textParts = [];
  if (title) {
    textParts.push('\n' + title + '.\n');
  }
  
  contentElements.forEach(el => {
    // Skip <p> elements that are children of <li> to avoid duplication
    if (el.tagName === 'P' && el.parentElement && el.parentElement.tagName === 'LI') {
      return;
    }
    
    const text = el.textContent.trim();
    if (text.length > 0) {
      // Skip if this text is already contained in something we've added (prevents duplicate extraction)
      const isDuplicate = textParts.some(existing => existing.includes(text) || text.includes(existing));
      if (isDuplicate) {
        return;
      }
      
      // Add extra spacing for headings
      if (el.tagName.match(/^H[1-6]$/)) {
        textParts.push('\n' + text + '\n');
      } else {
        textParts.push(text);
      }
    }
  });
  
  // DEBUG: Log textParts to see what elements were extracted
  console.log('[OfflineTTS] DEBUG textParts:', textParts.slice(0, 5));  // First 5 parts
  
  let text = textParts.join('\n\n');
  
  // DEBUG: Log joined text (first 500 chars) to see if \n\n exists BEFORE cleanup
  console.log('[OfflineTTS] DEBUG joined text (before cleanup):', text.substring(0, 500).replace(/\n/g, '\\n'));
  
  // If we didn't get much from structured elements, fall back to textContent
  if (text.length < MIN_CONTENT_LENGTH) {
    text = clone.textContent || '';
  }
  
  // Clean up whitespace (preserve newlines for chunk boundaries)
  text = text
    .replace(/[^\S\n]+/g, ' ')  // Multiple spaces to single space, but preserve newlines
    .replace(/\n\s*\n\s*\n+/g, '\n\n')  // Multiple newlines to double newline
    .replace(/^[^\S\n]+|[^\S\n]+$/gm, '')  // Trim spaces/tabs at line boundaries, but preserve newlines
    .trim();
  
  // DEBUG: Log text AFTER cleanup to see if \n\n is preserved
  console.log('[OfflineTTS] DEBUG text (after cleanup):', text.substring(0, 500).replace(/\n/g, '\\n'));
  
  // Title is already in textParts (seeded at the beginning), so no need to prepend
  
  // DEBUG: Log final text being returned
  console.log('[OfflineTTS] DEBUG final text:', text.substring(0, 500).replace(/\n/g, '\\n'));
  
  console.log(`[OfflineTTS] Extracted ${text.length} characters`);
  
  return text;
}

/**
 * Extract the page/article title
 * Tries site-specific selectors first, then generic selectors
 * @returns {string|null} Page title or null if not found
 */
function extractPageTitle() {
  const hostname = window.location.hostname.replace('www.', '');
  
  // Site-specific title selectors
  const siteTitleSelectors = {
    'wikipedia.org': '#firstHeading, .mw-page-title-main',
    'en.wikipedia.org': '#firstHeading, .mw-page-title-main',
    'medium.com': 'h1',
    'nytimes.com': 'h1[data-testid="headline"]',
    'theguardian.com': 'h1',
    'bbc.com': 'h1',
    'bbc.co.uk': 'h1',
    'cnn.com': 'h1.headline',
    'github.com': '.markdown-body h1, .repo-name',
    'reddit.com': 'h1',
    'substack.com': 'h1.post-title',
  };
  
  let titleElement = null;
  
  // Try site-specific selector first
  for (const [site, selector] of Object.entries(siteTitleSelectors)) {
    if (hostname.includes(site.replace('www.', ''))) {
      titleElement = document.querySelector(selector);
      if (titleElement) {
        console.log(`[OfflineTTS] Found title using site-specific selector for ${site}`);
        break;
      }
    }
  }
  
  // Generic title selectors
  if (!titleElement) {
    const genericTitleSelectors = [
      'article h1',
      'main h1',
      '.entry-title',
      '.post-title',
      '.article-title',
      '.page-title',
      'h1.title',
      'h1',
    ];
    
    for (const selector of genericTitleSelectors) {
      titleElement = document.querySelector(selector);
      if (titleElement && titleElement.textContent.trim().length > 0) {
        console.log(`[OfflineTTS] Found title using generic selector: ${selector}`);
        break;
      }
      titleElement = null;
    }
  }
  
  if (titleElement) {
    const title = titleElement.textContent.trim();
    console.log(`[OfflineTTS] Page title: "${title}"`);
    return title;
  }
  
  // Fallback: use document.title but clean it up (remove site name)
  let docTitle = document.title;
  // Remove common suffixes like " - Wikipedia", " | Medium", etc.
  docTitle = docTitle.split(/\s*[-|–—]\s*/)[0].trim();
  
  if (docTitle && docTitle.length > 0 && docTitle.length < 200) {
    console.log(`[OfflineTTS] Using document.title: "${docTitle}"`);
    return docTitle;
  }
  
  return null;
}
