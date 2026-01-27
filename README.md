# Music App (Offline PWA)

A clean, offline-friendly web music app you can host on Vercel (no app store).

It lets you import MP3 folders or individual songs, saves them locally in the browser (IndexedDB), and works offline after import.

## What it does

- Imports folders (`Import Folder`) or individual songs (`Import Songs`)
- Builds a master library with:
  - Favorites tab
  - Search
  - Sort by title, artist, album, duration, date added, folder, filename
  - Filters by artist, album, and folder
- Offline playback after import
- Installable as an app (PWA)

## Important limitations (by design)

- Browsers cannot auto-scan local folders. You must click **Import Folder** and choose the folder, or use the embedded songs folder described below.
- Music is stored per-device/per-browser. Each device needs its own import.
- Do **not** commit music files to GitHub; they are large and often copyrighted.

## Local development

From this folder (`C:\Users\labar\Downloads\mom-music-app`):

```powershell
npm install
npm run dev
```

Then open the shown local URL.

## Using your `Downloads\Music` folder

1. Put your songs inside `C:\Users\labar\Downloads\Music`.
2. Run the app locally.
3. Click **Import Folder**.
4. Select the `Music` folder.

After import finishes, the songs will play offline.

## Embedded songs folder (auto-sync)

You can also drop songs directly into the app so they appear automatically.

1. Put songs anywhere under `public/songs`.
2. Run `npm run generate:songs`.
3. Start the app with `npm run dev`.

On startup, the app syncs songs from `public/songs/manifest.json` into IndexedDB.

Notes:
- If the dev server is already running, restart it after generating the manifest.
- Browser storage quotas still apply. Thousands of songs may exceed the available space.
- Folders under `public/songs` appear under the Albums tab. Each folder becomes an album.

## Deploy to Vercel (recommended free path)

The app itself deploys great on Vercel. The music does not get uploaded — it stays local on the user's device.

High-level steps:

1. Push this repo to GitHub.
2. In Vercel, create a new project from the GitHub repo.
3. Use the default Vite settings:
   - Build command: `npm run build`
   - Output directory: `dist`

## GitHub push (already initialized locally)

If a remote is not set yet, you can use GitHub CLI:

```powershell
gh repo create mom-music-app --public --source . --remote origin --push
```

Or manually add a remote and push:

```powershell
git remote add origin https://github.com/<your-username>/mom-music-app.git
git add .
git commit -m "Initial Music App offline PWA"
git push -u origin main
```

## Tech notes

- React + TypeScript + Vite
- IndexedDB via `idb`
- Metadata parsing via `music-metadata-browser` (lazy-loaded)
- PWA via `vite-plugin-pwa`

## Icon credits

```text
Right arrow icons created by rukanicon - Flaticon
https://www.flaticon.com/free-icons/right-arrow

Rewind icons created by Freepik - Flaticon
https://www.flaticon.com/free-icons/rewind

Heart icons created by Gregor Cresnar - Flaticon
https://www.flaticon.com/free-icons/heart

Shuffle arrows icons created by Tempo_doloe - Flaticon
https://www.flaticon.com/free-icons/shuffle-arrows

Settings icons created by Pixel perfect - Flaticon
https://www.flaticon.com/free-icons/settings
```
