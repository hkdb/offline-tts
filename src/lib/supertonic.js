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

/**
 * Supertonic TTS Engine for Browser Extension
 * Adapted from https://github.com/supertone-inc/supertonic
 * 
 * This file provides TTS synthesis using ONNX Runtime Web
 */

import * as ort from 'onnxruntime-web/webgpu';

/**
 * Unicode Text Processor
 */
class UnicodeProcessor {
  constructor(indexer) {
    this.indexer = indexer;
  }

  call(textList) {
    const processedTexts = textList.map(text => this.preprocessText(text));
    
    const textIdsLengths = processedTexts.map(text => text.length);
    const maxLen = Math.max(...textIdsLengths);
    
    const textIds = processedTexts.map(text => {
      const row = new Array(maxLen).fill(0);
      for (let j = 0; j < text.length; j++) {
        const codePoint = text.codePointAt(j);
        row[j] = (codePoint < this.indexer.length) ? this.indexer[codePoint] : -1;
      }
      return row;
    });
    
    const textMask = this.getTextMask(textIdsLengths);
    return { textIds, textMask };
  }

  preprocessText(text) {
    text = text.normalize('NFKD');

    // Remove emojis
    const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
    text = text.replace(emojiPattern, '');

    // Replace various dashes and symbols
    const replacements = {
      '–': '-', '‑': '-', '—': '-', '¯': ' ', '_': ' ',
      '"': '"', '"': '"', '\u2018': "'", '\u2019': "'",
      '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ',
      '/': ' ', '#': ' ', '→': ' ', '←': ' ',
    };
    for (const [k, v] of Object.entries(replacements)) {
      text = text.replaceAll(k, v);
    }

    // Remove combining diacritics
    text = text.replace(/[\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u030A\u030B\u030C\u0327\u0328\u0329\u032A\u032B\u032C\u032D\u032E\u032F]/g, '');

    // Remove special symbols
    text = text.replace(/[♥☆♡©\\]/g, '');

    // Replace known expressions
    const exprReplacements = {
      '@': ' at ',
      'e.g.,': 'for example, ',
      'i.e.,': 'that is, ',
    };
    for (const [k, v] of Object.entries(exprReplacements)) {
      text = text.replaceAll(k, v);
    }

    // Fix spacing around punctuation
    text = text.replace(/ ,/g, ',');
    text = text.replace(/ \./g, '.');
    text = text.replace(/ !/g, '!');
    text = text.replace(/ \?/g, '?');
    text = text.replace(/ ;/g, ';');
    text = text.replace(/ :/g, ':');
    text = text.replace(/ '/g, "'");

    // Remove duplicate quotes
    while (text.includes('""')) text = text.replace('""', '"');
    while (text.includes("''")) text = text.replace("''", "'");
    while (text.includes('``')) text = text.replace('``', '`');

    // Remove extra spaces
    text = text.replace(/\s+/g, ' ').trim();

    // Add period if needed
    if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) {
      text += '.';
    }

    return text;
  }

  getTextMask(textIdsLengths) {
    const maxLen = Math.max(...textIdsLengths);
    return this.lengthToMask(textIdsLengths, maxLen);
  }

  lengthToMask(lengths, maxLen = null) {
    const actualMaxLen = maxLen || Math.max(...lengths);
    return lengths.map(len => {
      const row = new Array(actualMaxLen).fill(0.0);
      for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
        row[j] = 1.0;
      }
      return [row];
    });
  }
}

/**
 * Style class to hold TTL and DP tensors
 */
class Style {
  constructor(ttlTensor, dpTensor) {
    this.ttl = ttlTensor;
    this.dp = dpTensor;
  }
}

/**
 * Text-to-Speech engine using ONNX Runtime
 * Handles text preprocessing, duration prediction, text encoding, 
 * vector estimation (denoising), and vocoding
 */
class TextToSpeech {
  constructor(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt) {
    this.cfgs = cfgs;
    this.textProcessor = textProcessor;
    this.dpOrt = dpOrt;
    this.textEncOrt = textEncOrt;
    this.vectorEstOrt = vectorEstOrt;
    this.vocoderOrt = vocoderOrt;
    this.sampleRate = cfgs.ae.sample_rate;
  }

  async _infer(textList, style, totalStep, speed = 1.05, progressCallback = null) {
    const bsz = textList.length;
    
    // Process text
    const { textIds, textMask } = this.textProcessor.call(textList);
    
    const textIdsFlat = new BigInt64Array(textIds.flat().map(x => BigInt(x)));
    const textIdsShape = [bsz, textIds[0].length];
    const textIdsTensor = new ort.Tensor('int64', textIdsFlat, textIdsShape);
    
    const textMaskFlat = new Float32Array(textMask.flat(2));
    const textMaskShape = [bsz, 1, textMask[0][0].length];
    const textMaskTensor = new ort.Tensor('float32', textMaskFlat, textMaskShape);
    
    // Predict duration
    const dpOutputs = await this.dpOrt.run({
      text_ids: textIdsTensor,
      style_dp: style.dp,
      text_mask: textMaskTensor
    });
    const duration = Array.from(dpOutputs.duration.data);
    
    // Apply speed factor
    for (let i = 0; i < duration.length; i++) {
      duration[i] /= speed;
    }
    
    // Encode text
    const textEncOutputs = await this.textEncOrt.run({
      text_ids: textIdsTensor,
      style_ttl: style.ttl,
      text_mask: textMaskTensor
    });
    const textEmb = textEncOutputs.text_emb;
    
    // Sample noisy latent
    let { xt, latentMask } = this.sampleNoisyLatent(
      duration,
      this.sampleRate,
      this.cfgs.ae.base_chunk_size,
      this.cfgs.ttl.chunk_compress_factor,
      this.cfgs.ttl.latent_dim
    );
    
    const latentMaskFlat = new Float32Array(latentMask.flat(2));
    const latentMaskShape = [bsz, 1, latentMask[0][0].length];
    const latentMaskTensor = new ort.Tensor('float32', latentMaskFlat, latentMaskShape);
    
    // Prepare constant arrays
    const totalStepArray = new Float32Array(bsz).fill(totalStep);
    const totalStepTensor = new ort.Tensor('float32', totalStepArray, [bsz]);
    
    // Denoising loop
    for (let step = 0; step < totalStep; step++) {
      if (progressCallback) {
        progressCallback(step + 1, totalStep);
      }
      
      const currentStepArray = new Float32Array(bsz).fill(step);
      const currentStepTensor = new ort.Tensor('float32', currentStepArray, [bsz]);
      
      const xtFlat = new Float32Array(xt.flat(2));
      const xtShape = [bsz, xt[0].length, xt[0][0].length];
      const xtTensor = new ort.Tensor('float32', xtFlat, xtShape);
      
      const vectorEstOutputs = await this.vectorEstOrt.run({
        noisy_latent: xtTensor,
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMaskTensor,
        text_mask: textMaskTensor,
        current_step: currentStepTensor,
        total_step: totalStepTensor
      });
      
      const denoised = Array.from(vectorEstOutputs.denoised_latent.data);
      
      // Reshape to 3D
      const latentDim = xt[0].length;
      const latentLen = xt[0][0].length;
      xt = [];
      let idx = 0;
      for (let b = 0; b < bsz; b++) {
        const batch = [];
        for (let d = 0; d < latentDim; d++) {
          const row = [];
          for (let t = 0; t < latentLen; t++) {
            row.push(denoised[idx++]);
          }
          batch.push(row);
        }
        xt.push(batch);
      }
    }
    
    // Generate waveform
    const finalXtFlat = new Float32Array(xt.flat(2));
    const finalXtShape = [bsz, xt[0].length, xt[0][0].length];
    const finalXtTensor = new ort.Tensor('float32', finalXtFlat, finalXtShape);
    
    const vocoderOutputs = await this.vocoderOrt.run({
      latent: finalXtTensor
    });
    
    const wav = Array.from(vocoderOutputs.wav_tts.data);
    
    return { wav, duration };
  }

  async call(text, style, totalStep, speed = 1.05, silenceDuration = 0.3, progressCallback = null) {
    if (style.ttl.dims[0] !== 1) {
      throw new Error('Single speaker TTS only supports single style');
    }
    
    const textList = chunkTextForSynthesis(text);
    let wavCat = [];
    let durCat = 0;
    
    for (const chunk of textList) {
      const { wav, duration } = await this._infer([chunk], style, totalStep, speed, progressCallback);
      
      if (wavCat.length === 0) {
        wavCat = wav;
        durCat = duration[0];
      } else {
        const silenceLen = Math.floor(silenceDuration * this.sampleRate);
        const silence = new Array(silenceLen).fill(0);
        wavCat = [...wavCat, ...silence, ...wav];
        durCat += duration[0] + silenceDuration;
      }
    }
    
    return { wav: wavCat, duration: [durCat] };
  }

  sampleNoisyLatent(duration, sampleRate, baseChunkSize, chunkCompress, latentDim) {
    const bsz = duration.length;
    const maxDur = Math.max(...duration);
    
    const wavLenMax = Math.floor(maxDur * sampleRate);
    const wavLengths = duration.map(d => Math.floor(d * sampleRate));
    
    const chunkSize = baseChunkSize * chunkCompress;
    const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
    const latentDimVal = latentDim * chunkCompress;
    
    const xt = [];
    for (let b = 0; b < bsz; b++) {
      const batch = [];
      for (let d = 0; d < latentDimVal; d++) {
        const row = [];
        for (let t = 0; t < latentLen; t++) {
          // Box-Muller transform
          const u1 = Math.max(0.0001, Math.random());
          const u2 = Math.random();
          const val = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
          row.push(val);
        }
        batch.push(row);
      }
      xt.push(batch);
    }
    
    const latentLengths = wavLengths.map(len => Math.floor((len + chunkSize - 1) / chunkSize));
    const latentMask = this.lengthToMask(latentLengths, latentLen);
    
    // Apply mask
    for (let b = 0; b < bsz; b++) {
      for (let d = 0; d < latentDimVal; d++) {
        for (let t = 0; t < latentLen; t++) {
          xt[b][d][t] *= latentMask[b][0][t];
        }
      }
    }
    
    return { xt, latentMask };
  }

  lengthToMask(lengths, maxLen = null) {
    const actualMaxLen = maxLen || Math.max(...lengths);
    return lengths.map(len => {
      const row = new Array(actualMaxLen).fill(0.0);
      for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
        row[j] = 1.0;
      }
      return [row];
    });
  }
}

/**
 * Chunk text for TTS synthesis
 * Uses sentence-based splitting optimized for TTS model inference
 * @param {string} text - Text to chunk
 * @param {number} maxLen - Maximum chunk length (default: 300)
 * @returns {string[]} Array of text chunks
 */
function chunkTextForSynthesis(text, maxLen = 300) {
  if (typeof text !== 'string') {
    throw new Error(`chunkText expects a string, got ${typeof text}`);
  }
  
  // Split by paragraph
  const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
  
  const chunks = [];
  
  for (let paragraph of paragraphs) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;
    
    // Split by sentences
    const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);
    
    let currentChunk = "";
    
    for (let sentence of sentences) {
      if (currentChunk.length + sentence.length + 1 <= maxLen) {
        currentChunk += (currentChunk ? " " : "") + sentence;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
  }
  
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Write WAV file to ArrayBuffer
 */
function writeWavFile(audioData, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = audioData.length * 2;
  
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };
  
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  
  // Write audio data
  const int16Data = new Int16Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    const clamped = Math.max(-1.0, Math.min(1.0, audioData[i]));
    int16Data[i] = Math.floor(clamped * 32767);
  }
  
  const dataView = new Uint8Array(buffer, 44);
  dataView.set(new Uint8Array(int16Data.buffer));
  
  return buffer;
}

/**
 * Load voice style from JSON file (fetches from URL)
 */
async function loadVoiceStyle(stylePath) {
  const response = await fetch(stylePath);
  const voiceStyle = await response.json();
  return createStyleFromData(voiceStyle);
}

/**
 * Create Style from pre-loaded voice style data (no fetch needed)
 */
function createStyleFromData(voiceStyleData) {
  const ttlData = voiceStyleData.style_ttl.data.flat(Infinity);
  const dpData = voiceStyleData.style_dp.data.flat(Infinity);
  
  const ttlTensor = new ort.Tensor('float32', new Float32Array(ttlData), voiceStyleData.style_ttl.dims);
  const dpTensor = new ort.Tensor('float32', new Float32Array(dpData), voiceStyleData.style_dp.dims);
  
  return new Style(ttlTensor, dpTensor);
}

/**
 * Load TTS engine from pre-fetched data (ArrayBuffers, no fetch needed)
 * Used in sandboxed iframe where fetch to extension URLs is not allowed
 * @param {Object} modelData - Contains cfgs, indexer, dpModel, textEncModel, vectorEstModel, vocoderModel
 * @param {Function|null} progressCallback - Progress callback (message, current, total)
 * @param {string[]} executionProviders - ONNX execution providers (default: ['wasm'])
 */
async function loadSupertonicFromData(modelData, progressCallback = null, executionProviders = ['wasm']) {
  // modelData should contain: cfgs, indexer, dpModel, textEncModel, vectorEstModel, vocoderModel
  
  if (progressCallback) progressCallback('Loading config...', 0, 5);
  const cfgs = modelData.cfgs;
  
  if (progressCallback) progressCallback('Loading text processor...', 1, 5);
  const textProcessor = new UnicodeProcessor(modelData.indexer);
  
  // Session options - optimized for WebGPU/WASM stability
  // Based on: https://medium.com/@GenerationAI/transformers-js-onnx-runtime-webgpu-in-chrome-extension-13b563933ca9
  const sessionOptions = {
    executionProviders: executionProviders,
    enableMemPattern: false,
    enableCpuMemArena: false,
    extra: {
      session: {
        disable_prepacking: '1',
        use_device_allocator_for_initializers: '1',
        use_ort_model_bytes_directly: '1',
        use_ort_model_bytes_for_initializers: '1',
        disable_cpu_ep_fallback: '0',  // Allow CPU fallback for unsupported ops
      },
    },
  };
  
  console.log('[Supertonic] Using execution providers:', executionProviders);
  
  // Load ONNX models from ArrayBuffers
  if (progressCallback) progressCallback('Loading duration predictor...', 2, 5);
  const dpOrt = await ort.InferenceSession.create(modelData.dpModel, sessionOptions);
  
  if (progressCallback) progressCallback('Loading text encoder...', 3, 5);
  const textEncOrt = await ort.InferenceSession.create(modelData.textEncModel, sessionOptions);
  
  if (progressCallback) progressCallback('Loading vector estimator...', 4, 5);
  const vectorEstOrt = await ort.InferenceSession.create(modelData.vectorEstModel, sessionOptions);
  
  if (progressCallback) progressCallback('Loading vocoder...', 5, 5);
  const vocoderOrt = await ort.InferenceSession.create(modelData.vocoderModel, sessionOptions);
  
  return new TextToSpeech(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt);
}

// ES Module exports
export {
  loadSupertonicFromData,
  loadVoiceStyle,
  createStyleFromData,
  writeWavFile,
  chunkTextForSynthesis
};
