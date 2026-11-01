# SKY IPTV

An IPTV player for Samsung TVs (Tizen) that loads an M3U / Xtream playlist.
Built for the remote control: it separates live channels, movies and series,
and lets you **switch audio and subtitle tracks during playback**.

> The interface is in English by default and can be switched to Turkish in
> Settings. Both dictionaries live in `js/i18n.js`; adding a language means
> copying one dictionary and translating the values.

![SKY IPTV](img/icon.png)

## Features

- Loads M3U / m3u_plus (Xtream) playlists and caches them in IndexedDB, so the
  channel list appears instantly on launch and refreshes in the background
- Live / Movies / Series / Favourites tabs with a horizontal, wrapping category
  strip (the last category is two key presses away)
- Live channels as a three-column list, movies and series as a poster grid
- Series are grouped automatically: `Show Name S01 E05` -> show > season > episode
- Remote-friendly search with an alphabetical on-screen keyboard, insensitive to
  Turkish characters (typing `sisli` finds `Şişli`)
- Favourites, resume support (it asks whether to resume or start over) and
  automatic play of the next episode
- **Embedded subtitle extraction**: `mov_text` subtitles inside MP4 files are
  pulled straight from the server and rendered by the app (see below)
- Audio track / subtitle track selection, subtitle size, aspect ratio
- Channel list while watching: pressing back keeps the stream full screen and
  opens the list in a translucent panel on the left
- Fast seeking: the target moves on screen and a single seek request is sent
  once you stop pressing
- Stall recovery: a frozen stream is reconnected in place (live at the live
  edge, VOD at the last position) instead of dropping you into an error dialog
- Settings screen: interface language (English / Turkish), playlist source,
  subtitle size, buffer depth (2 to 12 seconds, default 8: raise it on a shaky
  connection, the start buffer stays short so zapping remains fast), reload and
  cache reset

## Remote control

| Key | Action |
|---|---|
| Arrows | Navigate (tabs / category strip / list) |
| OK | Select; opens the control bar during playback |
| Back | One level up; during playback returns to the list it was started from and keeps playing |
| Red | Toggle favourite |
| Green | Search |
| Yellow | Reload playlist; subtitle menu during playback |
| Blue | Change source; subtitle size during playback |
| Channel +/- | Page jump; previous/next channel or episode during playback |
| Play / Pause | As expected; brings the stream back to full screen from the list |
| Rewind / Forward | Moves the seek target, jumps when released (not on live TV) |
| INFO | Show/hide the diagnostic log overlay |

The Settings button sits next to Search in the top bar.

## Installation

An IPTV player cannot realistically be published on the Samsung Store, so the
app is installed through Developer Mode. **Installing from USB is not supported
on consumer Samsung TVs**; installation is done from a computer on the same
local network.

1. **Enable developer mode on the TV**: open the Apps screen, press `1 2 3 4 5`
   on the remote, set Developer mode to On, enter your computer's IP address in
   "Host PC IP", then power-cycle the TV.
2. **Install the Tizen CLI** on your computer:
   [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
   (the CLI package is enough).
3. **Create a signing profile** - unsigned packages are rejected by the TV. A
   self-signed certificate is enough for developer mode:
   ```powershell
   tizen certificate -a SkyIptv -p PASSWORD -f skyiptv
   tizen security-profiles add -n skyiptv -a <keystore>\skyiptv.p12 -p PASSWORD
   ```
   Alternatively use Tizen Studio's Certificate Manager with a Samsung account.
4. **Build and install**:
   ```powershell
   .\build.ps1 -TvIp 192.168.1.50 -Run
   ```
   Run it without arguments to only produce `dist\SkyIptv.wgt`.

A prebuilt `.wgt` is attached to each [release](../../releases). After
downloading it:

```powershell
.\install.ps1 -TvIp 192.168.1.50 -Run
```

Step-by-step instructions and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md)

If the certificate expires or developer mode is turned off, the TV may remove
the app; reinstall it with the same command.

## Playlist source

On first launch the app asks for an M3U URL and stores it on the device. To ship
a subscription with the build instead, copy `js/local-config.example.js` to
`js/local-config.js` and put your URL there. That file is git-ignored, so
credentials never end up in the repository.

## Running it on a desktop

```powershell
node test\serve.js       # http://localhost:8790
```

Open `http://localhost:8790/index.html?demo=1` for the bundled sample playlist.
There is no `webapis` object in a desktop browser, so playback falls back to an
HTML5 `<video>` element.

To generate the sample playlist and test clip:

```powershell
node test\gen-demo.js
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=25:duration=20 `
       -f lavfi -i sine=frequency=440:duration=20 `
       -c:v libvpx -c:a libvorbis test\sample.webm
```

## Tests

```powershell
node test\smoke.js             # playlist parsing, category index, URL candidates
node test\qa.js                # drives Chrome over CDP, walks the screens, saves screenshots
node test\mp4probe.js <url>    # measures how subtitle samples are spread through an MP4
node test\subs-test.js <url>   # end-to-end check of subtitle extraction
```

## How it works

### Playback

Playback goes through `webapis.avplay`. The picture is drawn on the hardware
plane **below** the browser layer, which means the page has to be transparent
wherever video should be visible; anything opaque painted on top hides the
picture while audio keeps playing.

Xtream live URLs are usually raw MPEG-TS. The app tries the playlist URL first,
then the `.m3u8` variant, then `.ts`. On some streams `prepareAsync` never calls
back at all, so there is a 10-second timeout, plus a 12-second watchdog for the
case where preparation succeeds but no picture arrives. If nothing plays, the
error dialog lists every URL that was tried together with its HTTP result.

### Subtitles

AVPlay lists the `mov_text` (tx3g) tracks inside MP4 files but on some firmware
cannot decode them: selecting a track succeeds and no subtitle event ever fires.
The app therefore extracts subtitles from the file itself:

1. download the `moov` box at the head of the MP4
2. compute the byte range and timestamp of every subtitle sample from the
   `stts` / `stsc` / `stsz` / `stco` tables
3. fetch the samples around the current position, merging nearby byte ranges
   (a full episode is roughly 23 KB of text)
4. decode each tx3g sample (2-byte length + UTF-8 text) and render it

This also restores the language names, which AVPlay returns empty, and makes the
subtitle size adjustable. Once a track is complete it is cached on the device
and appears instantly the next time.

### Compatibility note

The Tizen 6.0 browser engine is Chromium 76. Flexbox `gap` (Chrome 84+) and the
`inset` shorthand (Chrome 87+) are **not supported**: spacing uses `margin` and
positions are written as `left/top/right/bottom`. On the JavaScript side,
optional chaining (`?.`) and nullish coalescing (`??`) are avoided for the same
reason.

## Layout

```
config.xml        Tizen application manifest (id, privileges, icon)
index.html        Single page; each screen is a <section>
css/app.css       Fixed 1920x1080 TV styling
js/util.js        Helpers (search folding, time formatting, XHR)
js/keys.js        Remote control key codes
js/store.js       Settings/favourites (localStorage) + playlist cache (IndexedDB)
js/m3u.js         M3U parser, category index, AVPlay URL candidates
js/keyboard.js    On-screen keyboard
js/subs.js        MP4 mov_text subtitle extractor
js/player.js      AVPlay wrapper, control bar, track menus
js/ui.js          Screens, virtualised list/grid, search, episodes
js/app.js         Startup flow (cache -> download -> parse)
js/i18n.js        Interface dictionaries (English, Turkish)
js/log.js         On-device diagnostic log (never leaves the device)
build.ps1         Packaging and installation
```

## Known limitations

- Subtitle extraction works with **MP4** only; for MKV the app falls back to
  AVPlay's own tracks.
- A true picture-in-picture window was attempted, but the test model
  (QN85A / Tizen 6.0) silently ignores `setDisplayRect` during playback. The
  channel list is therefore drawn as a translucent panel over the full-screen
  picture.
- No EPG support.
- No seeking on live streams.

## License

MIT
