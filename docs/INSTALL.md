# Installation

## Google Web Store (Recommended)

Coming soon! The easiest way to install OfflineTTS will be through the Chrome Web Store.

## Manual Installation (Pre-built Release)

If you prefer to avoid the Web Store, you can install a pre-built release:

1. Go to the [Releases page](https://github.com/hkdb/offline-tts/releases)
2. Download the latest `OfflineTTS-v*.zip` file
3. Extract the ZIP file to a folder on your computer
4. Open Chrome and navigate to `chrome://extensions/`
5. Enable **Developer mode** (toggle in top right corner)
6. Click **Load unpacked**
7. Select the extracted `OfflineTTS-v*` folder

The extension icon should appear in your toolbar!

## Build from Source

If you want to build the extension yourself, see [BUILDINSTALL.md](BUILDINSTALL.md) for detailed build instructions.

## First Run

When you first use OfflineTTS, the TTS models (~250MB) will load into memory. This takes a few seconds and happens each time you start Chrome. All models are already bundled with the extension - no downloading required.

## Updating

### Web Store version:
Updates will be automatic through Chrome.

### Manual update:
1. Download the new release ZIP
2. Extract to a new folder
3. Go to `chrome://extensions/`
4. Remove the old version
5. Click **Load unpacked** and select the new folder

