# Installation w/o Google Web Store

For those of you de-googled users, you can choose to install this installation without using the Google Web Store:

1. Clone this repository
2. Run `npm install`
3. Run `./scripts/download-deps.sh` (downloads ~300MB of models/libraries)
4. Run `npm run build`
5. Open Chrome and go to `chrome://extensions/`
6. Enable "Developer mode" (toggle in top right)
7. Click "Load unpacked"
8. Select the `build/` folder

