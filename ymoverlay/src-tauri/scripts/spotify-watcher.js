// Spotify stays in its own webview; all reads and actions use its rendered DOM.
(function () {
  if (location.origin !== "https://open.spotify.com" || window.__spotifyOverlay) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const text = (element) => element?.textContent?.trim() || "";
  const visible = (element) => element && (element.checkVisibility?.() ?? element.offsetParent !== null);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cache = new Map();
  const rowIds = new WeakMap();
  let nextId = 0;
  let queueOpen = true;
  let queueRequested = false;
  let playlistsOpen = false;
  let volumeTarget = null;
  let queueRows = new Map();
  let playlistRows = new Map();
  let playlistOptions = new Map();
  let playlistSession = 0;
  let playlistBusy = false;
  let ready = false;

  function emit(name, payload, changedOnly = false) {
    if (!window.__TAURI__?.event) return;
    const serialized = JSON.stringify(payload);
    if (changedOnly && cache.get(name) === serialized) return;
    cache.set(name, serialized);
    window.__TAURI__.event.emitTo("overlay", `spotify://${name}`, payload).catch(console.error);
  }

  function required(element, message) {
    if (!element) throw new Error(message);
    return element;
  }

  function click(element) {
    required(element, "This control is currently unavailable in Spotify.").click();
  }

  function seconds(value) {
    const parts = String(value || "").trim().split(":").map(Number);
    return parts.every(Number.isFinite) ? parts.reduce((total, part) => total * 60 + part, 0) : 0;
  }

  function timing() {
    const slider = $('[data-testid="playback-progressbar"] input');
    const maximum = Number(slider?.max);
    const position = seconds(text($('[data-testid="playback-position"]')));
    // The range property snaps to Spotify's 5000 ms keyboard step. React's
    // value attribute retains the exact position, and max is already in ms.
    const rawValue = slider?.getAttribute("value");
    const milliseconds = Number(rawValue);
    return {
      duration: maximum > 0 ? maximum / 1000 : seconds(text($('[data-testid="playback-duration"]'))),
      currentTime: rawValue != null && rawValue !== "" && Number.isFinite(milliseconds)
        ? milliseconds / 1000 : position,
    };
  }

  function setRange(input, fraction, precise = false) {
    required(input, "Spotify's slider is unavailable.");
    const minimum = Number(input.min) || 0;
    const maximum = Number(input.max) || 1;
    const value = minimum + Math.max(0, Math.min(1, fraction)) * (maximum - minimum);
    const step = input.getAttribute("step");
    // Seeking must not snap to the five-second keyboard step either.
    if (precise) input.setAttribute("step", "any");
    try {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } finally {
      if (precise) {
        if (step === null) input.removeAttribute("step");
        else input.setAttribute("step", step);
      }
    }
  }

  function seek(target) {
    const { duration } = timing();
    if (duration > 0) setRange($('[data-testid="playback-progressbar"] input'), target / duration, true);
  }

  function readTrack() {
    const widget = $('[data-testid="now-playing-widget-v2"], [data-testid="now-playing-widget"]');
    if (!widget) return { title: "", artist: "", art: "" };
    return {
      title: text($('[data-testid="context-item-info-title"], a[href*="/track/"], a[href*="/album/"]', widget || document)),
      artist: $$('a[href*="/artist/"]', widget || document).map(text).join(", "),
      art: $('[data-testid="cover-art-image"], img', widget || document)?.src || "",
    };
  }

  function queueRoot() {
    const button = $('[data-testid="control-button-queue"]');
    if (button?.getAttribute("aria-pressed") !== "true") return null;
    return $('[data-testid="queue"], [data-testid="queue-tab"], [data-testid="right-sidebar"], #Desktop_PanelContainer_Id');
  }

  function openQueueOnce() {
    const button = $('[data-testid="control-button-queue"]');
    if (!queueRequested || !button) return;
    queueRequested = false;
    if (button.getAttribute("aria-pressed") !== "true") button.click();
  }

  function readQueue() {
    const root = queueRoot();
    if (!root) { queueRows.clear(); return []; }
    const track = readTrack();
    const rows = new Map();
    const items = $$('[data-encore-id="listRow"], [data-testid="tracklist-row"]', root).flatMap((row) => {
      const title = text($('[data-encore-id="listRowTitle"], [data-testid="listrow-title"], [data-testid="internal-track-link"]', row));
      if (!title) return [];
      const artist = $$('a[href*="/artist/"]', row).map(text).join(", ")
        || text($('[data-encore-id="listRowSubtitle"], [data-testid="listrow-subtitle"]', row));
      const key = `${title}\n${artist}`;
      let entry = rowIds.get(row);
      if (!entry || entry.key !== key) {
        entry = { id: String(nextId++), key };
        rowIds.set(row, entry);
      }
      rows.set(entry.id, row);
      return [{ id: entry.id, title, artist, art: $('img', row)?.src || "",
        active: title === track.title && artist === track.artist }];
    });
    queueRows = rows;
    return items;
  }

  function readPlaylists() {
    const sidebar = $('#Desktop_LeftSidebar_Id, [data-testid="left-sidebar"]');
    playlistRows.clear();
    if (!sidebar) return [];
    return $$('[data-encore-id="listRow"]', sidebar).flatMap((row) => {
      const link = $('a[href*="/playlist/"], a[href*="/collection/tracks"]', row);
      const uri = row.getAttribute("aria-labelledby")?.match(/spotify:(playlist:[\w]+|collection:tracks)/)?.[0];
      const href = link?.getAttribute("href") || (uri?.startsWith("spotify:playlist:")
        ? `/playlist/${uri.split(":").pop()}` : uri === "spotify:collection:tracks" ? "/collection/tracks" : "");
      if (!href) return [];
      playlistRows.set(href, row);
      return [{ id: href, href, title: text($('[data-encore-id="listRowTitle"]', row)) || text(link),
        author: text($('[data-encore-id="listRowSubtitle"]', row)), art: $('img', row)?.src || "" }];
    });
  }

  async function until(find, message, current = () => true) {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (!current()) throw Object.assign(new Error("Action cancelled."), { name: "AbortError" });
      const result = find();
      if (result) return result;
      await wait(200);
    }
    throw new Error(message);
  }

  async function playPlaylist(playlist, options) {
    readPlaylists();
    const row = required(playlistRows.get(playlist.id), "Playlist is no longer in Spotify's sidebar.");
    click($('[role="button"][aria-labelledby], a[href]', row));
    await until(() => location.pathname === playlist.href, "Spotify could not open this playlist.");
    await until(() => text($('main h1')) === playlist.title && $('main [data-testid="play-button"]'),
      "Playlist Play button is unavailable.");
    if (typeof options?.shuffle === "boolean") await setShuffle(options.shuffle);
    if (location.pathname !== playlist.href || text($('main h1')) !== playlist.title) {
      throw new Error("The playlist page changed. Playback was not started.");
    }
    click($('main [data-testid="play-button"]'));
  }

  // Spotify's current playlist controls expose their mode through semantic
  // color classes and SVG glyphs instead of test IDs or translated labels.
  const SHUFFLE_ICON = 'svg path[d^="M13.151.922"], svg path[d^="M18.788 3.702"]';
  const SMART_SHUFFLE_ICON = 'svg path[d^="M4.502 0a.637"], svg path[d^="M7.335.6a.667"]';

  function shuffleControl() {
    const main = $('main');
    return (main && $(`${SHUFFLE_ICON}, ${SMART_SHUFFLE_ICON}`, main)?.closest("button"))
      || $('[data-testid="control-button-shuffle"]');
  }

  function shuffleMode(button) {
    if (!button) return null;
    const checked = button.getAttribute("aria-checked") ?? button.getAttribute("aria-pressed");
    if ($(SMART_SHUFFLE_ICON, button) || checked === "mixed") return "smart";
    return checked === "true" || button.classList.contains("encore-internal-color-text-bright-accent")
      ? "on" : "off";
  }

  async function setShuffle(enabled) {
    const target = enabled ? "on" : "off";
    // Cycle off -> shuffle -> smart shuffle -> off, awaiting each actual
    // transition. Play must never run if Spotify fails to confirm the mode.
    for (let attempt = 0; attempt < 3; attempt++) {
      const button = await until(() => {
        const control = shuffleControl();
        return control && !control.disabled && control.getAttribute("aria-disabled") !== "true" && control;
      }, "Spotify's shuffle control is unavailable.");
      const previous = shuffleMode(button);
      if (previous === target) return;
      click(button);
      await until(() => {
        const mode = shuffleMode(shuffleControl());
        return mode !== null && mode !== previous;
      }, "Spotify did not confirm the shuffle mode. Playback was not started.");
    }
    throw new Error("Spotify could not set the requested shuffle mode. Playback was not started.");
  }

  function menuItems() {
    return $$('[role="menuitem"], [role="menuitemcheckbox"]').filter(visible);
  }

  // The plus glyph is shared by Add to playlist and Create playlist;
  // matching its SVG geometry is independent of Spotify's display language.
  const PLUS_ICON = 'svg path[d^="M15.25 8a.75"]';

  function isPlaying(play) {
    const state = navigator.mediaSession?.playbackState;
    if (state === "playing" || state === "paused") return state === "playing";
    const media = $$('audio, video').filter((element) => element.currentSrc);
    if (media.length) return media.some((element) => !element.paused && !element.ended);
    // This WebView2 player may leave MediaSession at "none" and keep its
    // media outside the document. Its two-bar pause glyph is language-neutral.
    return !!$('svg path[d^="M2.7 1a.7.7"]', play);
  }

  async function addToPlaylist(id) {
    const session = ++playlistSession;
    const current = () => session === playlistSession;
    playlistOptions.clear();
    readQueue();
    const row = required(queueRows.get(String(id)), "Track is no longer in the visible Spotify queue.");
    const menuButton = $('button[aria-haspopup="menu"], [data-testid="more-button"]', row);
    if (menuButton) menuButton.click();
    else row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window }));
    const add = await until(() => menuItems().find((item) => item.hasAttribute("aria-expanded") && $(PLUS_ICON, item)),
      "Spotify's Add to playlist menu is unavailable.", current);
    if (!current()) return;
    add.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    add.click();
    const submenu = await until(() => {
      const menu = $('[role="menu"]', add.parentElement);
      return menu && visible(menu) && $$('button[role="menuitem"], button[role="menuitemcheckbox"]', menu).length && menu;
    }, "Spotify's playlist picker is unavailable.", current);
    if (!current()) return;
    playlistOptions = new Map($$('button[role="menuitem"], button[role="menuitemcheckbox"]', submenu)
      .filter((item) => visible(item) && !$(PLUS_ICON, item) && item.getAttribute("aria-disabled") !== "true")
      .filter((item) => text(item))
      .map((item, index) => [`${session}:${index}`, { item, label: text(item), submenu }]));
    const options = Array.from(playlistOptions, ([id, { label }]) => ({ id, label }));
    emit("add-to-playlist-options", { index: Number(id), options });
  }

  const actions = {
    togglePlay: () => click($('[data-testid="control-button-playpause"]')),
    next: () => click($('[data-testid="control-button-skip-forward"]')),
    prev: () => click($('[data-testid="control-button-skip-back"]')),
    seek,
    skip: (delta) => seek(timing().currentTime + delta),
    volume: (percent) => {
      volumeTarget = Math.max(0, Math.min(100, percent)) / 100;
      const input = $('[data-testid="volume-bar"] input');
      if (input) setRange(input, volumeTarget);
    },
    queue: (open) => {
      queueOpen = open;
      queueRequested = open;
      openQueueOnce();
      cache.delete("track");
      if (open) emit("queue", readQueue());
    },
    playlists: () => emit("playlists", readPlaylists()),
    playlistPanel: (open) => { playlistsOpen = open; },
    playPlaylist: async (...args) => {
      if (playlistBusy) return;
      playlistBusy = true;
      try { await playPlaylist(...args); }
      finally { playlistBusy = false; }
    },
    selectTrack: (id) => {
      readQueue();
      const row = required(queueRows.get(String(id)), "Track is no longer in the visible Spotify queue.");
      const button = $('[data-testid="play-button"]', row) || $('[role="button"][aria-labelledby]', row);
      if (button) button.click();
      else row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    },
    addToPlaylist,
    confirmPlaylist: (id) => {
      const choice = playlistOptions.get(id);
      if (!choice?.item.isConnected || !visible(choice.item) || !choice.submenu.contains(choice.item)
        || text(choice.item) !== choice.label || choice.item.getAttribute("aria-disabled") === "true") {
        throw new Error("Spotify's playlist picker has closed or changed. Please open it again.");
      }
      click(choice.item);
      playlistSession++;
      playlistOptions.clear();
    },
    cancelPlaylist: () => {
      playlistSession++;
      playlistOptions.clear();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    },
  };

  window.__spotifyOverlay = {
    async command(action, args = []) {
      try {
        emit("error", "");
        required(actions[action], "Unknown Spotify action.");
        await actions[action](...args);
      } catch (error) {
        if (error.name === "AbortError") return;
        emit("error", String(error.message || error));
        if (action === "addToPlaylist") emit("add-to-playlist-options", { index: args[0], options: [] });
      }
    },
  };

  function tick() {
    try {
      if (!window.__TAURI__?.event) return;
      if (!ready) { ready = true; emit("ready", null); }
      const play = $('[data-testid="control-button-playpause"]');
      if (!play) return;
      const volume = $('[data-testid="volume-bar"] input');
      if (volume && volumeTarget !== null) {
        setRange(volume, volumeTarget);
        volumeTarget = null;
      }
      emit("tick", { ...timing(), isPlaying: isPlaying(play),
        volume: Number(volume?.value ?? 1) });
      emit("track", readTrack(), true);
      if (queueOpen) { openQueueOnce(); emit("queue", readQueue(), true); }
      if (playlistsOpen) emit("playlists", readPlaylists(), true);
    } catch (error) { console.warn("[spotify-overlay]", error); }
  }
  setInterval(tick, 1000);
})();
