'use strict';

/**
 * Mini Player — a sidebar player for Obsidian backed by go-librespot.
 *
 * This plugin plays no audio itself. It is a remote control for a local
 * go-librespot instance (https://github.com/devgianlu/go-librespot), which the
 * user installs and runs separately. A Spotify Premium account is required.
 *
 * Obsidian cannot play Spotify audio directly: the Spotify Web Playback SDK
 * needs the Widevine DRM module, which Obsidian's Electron build does not ship.
 *
 * Requests go through requestUrl() rather than fetch(), because requests sent
 * from Obsidian's origin (app://obsidian.md) can be blocked by CORS.
 * requestUrl() is proxied by Obsidian itself and is not subject to that.
 *
 * The Spotify Web API is only used to look up a display name, and the token for
 * it comes from go-librespot's own POST /token endpoint. This plugin never asks
 * for, sees, or stores Spotify credentials.
 */

const {
  Plugin, ItemView, PluginSettingTab, Setting, Notice, requestUrl,
  Modal, FuzzySuggestModal,
} = require('obsidian');

const VIEW_TYPE_MINI_PLAYER = 'mini-player-view';

const DEFAULT_SETTINGS = {
  serverUrl: 'http://127.0.0.1:3678',
  playlists: [],
  pollMs: 3000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call the local go-librespot API. */
async function callApi(baseUrl, path, method = 'GET', body = null) {
  const opts = {
    url: String(baseUrl).replace(/\/+$/, '') + path,
    method,
    throw: false,
  };
  if (body) {
    opts.contentType = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await requestUrl(opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error('API ' + path + ' returned HTTP ' + res.status);
  }
  return res;
}

/**
 * Spotify access token, reused for 45 minutes.
 * Minting one on every call would itself count against the rate limit, and
 * Spotify tokens are typically valid for an hour.
 */
let tokenCache = { token: null, at: 0 };

async function getToken(baseUrl) {
  const now = Date.now();
  if (tokenCache.token && now - tokenCache.at < 45 * 60 * 1000) return tokenCache.token;
  const res = await callApi(baseUrl, '/token', 'POST');
  const t = res.json && res.json.token;
  if (!t) throw new Error('Could not obtain an access token');
  tokenCache = { token: t, at: now };
  return t;
}

/** Call the Spotify Web API. Retries briefly on 429, which is usually short-lived. */
async function webApi(baseUrl, path, retries = 3) {
  const token = await getToken(baseUrl);

  for (let i = 0; i <= retries; i++) {
    const res = await requestUrl({
      url: 'https://api.spotify.com/v1' + path,
      headers: { Authorization: 'Bearer ' + token },
      throw: false,
    });
    if (res.status === 429) {
      await sleep(1200 * (i + 1));
      continue;
    }
    if (res.status === 401) {
      // Drop the stale token so the next call mints a fresh one.
      tokenCache = { token: null, at: 0 };
      throw new Error('Token expired, please try again');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error('Spotify API returned HTTP ' + res.status);
    }
    return res.json;
  }
  throw new Error('Spotify is rate limiting, please wait and try again');
}

/**
 * Normalize input to spotify:type:id so a URL can be pasted as-is.
 *   https://open.spotify.com/playlist/xxxx?si=...  ->  spotify:playlist:xxxx
 *   https://open.spotify.com/intl-de/album/xxxx    ->  spotify:album:xxxx
 *   spotify:playlist:xxxx                          ->  unchanged
 */
function normalizeSpotifyUri(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (s.startsWith('spotify:')) return s.split('?')[0];
  const m = s.match(
    /open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(playlist|album|artist|track|show|episode)\/([A-Za-z0-9]+)/
  );
  if (m) return 'spotify:' + m[1] + ':' + m[2];
  return s;
}

function fmtTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/* ────────────────────────────── Modals ────────────────────────────── */

/** Config shown in the setup guide. audio_backend is left to the OS default. */
const CONFIG_TEMPLATE = [
  'device_name: Obsidian',
  'device_type: computer',
  'zeroconf_enabled: false',
  'credentials:',
  '  type: interactive',
  'bitrate: 320',
  'volume_steps: 100',
  'initial_volume: 60',
  'server:',
  '  enabled: true',
  '  address: localhost',
  '  port: 3678',
  "  allow_origin: '*'",
].join('\n');

/** Walks the user through installing and starting go-librespot. */
class SetupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('mp-setup');
    contentEl.createEl('h2', { text: 'Set up go-librespot' });
    contentEl.createEl('p', {
      text:
        'This plugin is only the interface. Audio is played by go-librespot, ' +
        'a lightweight Spotify Connect client that you run yourself. ' +
        'A Spotify Premium account is required.',
    });

    const ol = contentEl.createEl('ol');

    const li1 = ol.createEl('li');
    li1.createSpan({ text: 'Install go-librespot. ' });
    li1.createEl('a', {
      text: 'Releases',
      href: 'https://github.com/devgianlu/go-librespot/releases',
    });
    li1.createEl('br');
    li1.createSpan({ cls: 'mp-note', text: 'macOS / Linux: brew install go-librespot' });
    li1.createEl('br');
    li1.createSpan({
      cls: 'mp-note',
      text:
        'Windows: the official release is dynamically linked and needs MinGW DLLs ' +
        '(libogg, libvorbis, flac, mpg123). Use the statically linked build instead — ' +
        'see the plugin README.',
    });

    const li2 = ol.createEl('li');
    li2.createSpan({ text: 'Save this as config.yml next to the binary:' });
    const pre = li2.createEl('pre', { cls: 'mp-config' });
    pre.createEl('code', { text: CONFIG_TEMPLATE });
    const copyBtn = li2.createEl('button', { cls: 'mp-copy-btn', text: 'Copy config.yml' });
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(CONFIG_TEMPLATE);
        new Notice('Copied to clipboard');
      } catch (e) {
        new Notice('Could not copy: ' + e.message);
      }
    };

    const li3 = ol.createEl('li');
    li3.createSpan({ text: 'Run it:' });
    li3.createEl('br');
    li3.createEl('code', { text: 'go-librespot --config_dir <folder with config.yml>' });
    li3.createEl('br');
    li3.createSpan({ cls: 'mp-note', text: 'Note the double dash in --config_dir.' });

    ol.createEl('li', {
      text:
        'Open the authorization link printed in the log and sign in with your ' +
        'Spotify Premium account. This is only needed once.',
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Test connection').setCta().onClick(async () => {
        try {
          const res = await callApi(this.plugin.settings.serverUrl, '/status');
          new Notice('Connected: ' + (res.json.device_name || 'go-librespot'));
        } catch (e) {
          new Notice('Not connected: ' + e.message);
        }
      })
    );
  }

  onClose() { this.contentEl.empty(); }
}

/** Adds one item by pasting a URL or URI. */
class AddPlaylistModal extends Modal {
  constructor(app, plugin, onDone) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
    this.name = '';
    this.raw = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Add a playlist' });

    new Setting(contentEl)
      .setName('Display name')
      .setDesc('Leave empty to look up the name from Spotify')
      .addText((t) => t.setPlaceholder('Focus music').onChange((v) => { this.name = v; }));

    new Setting(contentEl)
      .setName('URL or URI')
      .setDesc('A Spotify URL can be pasted as-is')
      .addText((t) =>
        t.setPlaceholder('https://open.spotify.com/playlist/...').onChange((v) => { this.raw = v; })
      );

    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Add').setCta().onClick(() => this.submit())
    );
  }

  async submit() {
    const uri = normalizeSpotifyUri(this.raw);
    if (!uri.startsWith('spotify:')) {
      new Notice('Enter a Spotify URL or URI');
      return;
    }
    let name = this.name.trim();
    if (!name) name = await this.plugin.lookupName(uri);
    if (!name) {
      // Still add it if Spotify is rate limiting. The name can be edited later.
      const kind = { playlist: 'Playlist', album: 'Album', artist: 'Artist', track: 'Track' };
      name = kind[uri.split(':')[1]] || 'Item';
    }
    this.plugin.settings.playlists.push({ name, uri });
    await this.plugin.saveSettings();
    this.plugin.refreshViews();
    new Notice('Added: ' + name);
    this.close();
    if (this.onDone) this.onDone();
  }

  onClose() { this.contentEl.empty(); }
}

/** Picks one of the saved items and plays it. */
class SavedPlaylistModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Choose a saved playlist');
  }
  getItems() { return this.plugin.settings.playlists.filter((p) => p && p.uri); }
  getItemText(p) { return p.name || p.uri; }
  onChooseItem(p) { this.plugin.playUri(p.uri, p.name); }
}

/* ────────────────────────────── View ────────────────────────────── */

class MiniPlayerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.status = null;
    this.seeking = false;
    this.volumeDragging = false;
  }

  getViewType() { return VIEW_TYPE_MINI_PLAYER; }
  getDisplayText() { return 'Mini Player'; }
  getIcon() { return 'play-circle'; }

  async onOpen() {
    this.build();
    await this.refresh();
    this.registerInterval(
      window.setInterval(() => this.refresh(), this.plugin.settings.pollMs)
    );
  }

  async onClose() { /* registerInterval is cleaned up by Obsidian */ }

  build() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mini-player');

    // Cover art
    this.artEl = root.createDiv({ cls: 'mp-art' });
    this.artImgEl = this.artEl.createEl('img', { cls: 'mp-art-img' });
    this.artImgEl.style.display = 'none';
    this.artPlaceholderEl = this.artEl.createDiv({ cls: 'mp-art-ph', text: '♪' });

    // Track info
    const meta = root.createDiv({ cls: 'mp-meta' });
    this.titleEl = meta.createDiv({ cls: 'mp-title', text: '—' });
    this.artistEl = meta.createDiv({ cls: 'mp-artist', text: '' });

    // Seek bar
    const seekWrap = root.createDiv({ cls: 'mp-seek-wrap' });
    this.seekEl = seekWrap.createEl('input', { cls: 'mp-seek', type: 'range' });
    this.seekEl.min = '0';
    this.seekEl.max = '1000';
    this.seekEl.value = '0';
    this.seekEl.addEventListener('input', () => { this.seeking = true; });
    this.seekEl.addEventListener('change', async () => {
      const dur = this.status && this.status.track ? this.status.track.duration : 0;
      const pos = Math.floor((Number(this.seekEl.value) / 1000) * dur);
      this.seeking = false;
      await this.act('/player/seek', 'POST', { position: pos });
    });

    const times = root.createDiv({ cls: 'mp-times' });
    this.posEl = times.createSpan({ text: '0:00' });
    this.durEl = times.createSpan({ text: '0:00' });

    // Transport
    const ctrl = root.createDiv({ cls: 'mp-ctrl' });
    this.prevBtn = ctrl.createEl('button', { cls: 'mp-btn', text: '⏮' });
    this.playBtn = ctrl.createEl('button', { cls: 'mp-btn mp-btn-main', text: '▶' });
    this.nextBtn = ctrl.createEl('button', { cls: 'mp-btn', text: '⏭' });

    this.prevBtn.setAttribute('aria-label', 'Previous track');
    this.playBtn.setAttribute('aria-label', 'Play or pause');
    this.nextBtn.setAttribute('aria-label', 'Next track');

    this.prevBtn.onclick = () => this.act('/player/prev', 'POST');
    this.nextBtn.onclick = () => this.act('/player/next', 'POST');
    this.playBtn.onclick = () => this.act('/player/playpause', 'POST');

    // Volume
    const volWrap = root.createDiv({ cls: 'mp-vol-wrap' });
    volWrap.createSpan({ cls: 'mp-vol-icon', text: '🔉' });
    this.volEl = volWrap.createEl('input', { cls: 'mp-vol', type: 'range' });
    this.volEl.min = '0';
    this.volEl.max = '100';
    this.volEl.value = '60';
    this.volEl.setAttribute('aria-label', 'Volume');
    this.volEl.addEventListener('input', () => { this.volumeDragging = true; });
    this.volEl.addEventListener('change', async () => {
      const steps = (this.status && this.status.volume_steps) || 100;
      const v = Math.round((Number(this.volEl.value) / 100) * steps);
      this.volumeDragging = false;
      await this.act('/player/volume', 'POST', { volume: v });
    });

    // Playlists header
    const plHead = root.createDiv({ cls: 'mp-section-head' });
    plHead.createSpan({ cls: 'mp-section-label', text: 'Playlists' });
    const plActions = plHead.createDiv({ cls: 'mp-section-actions' });

    const addBtn = plActions.createEl('button', { cls: 'mp-mini-btn', text: '＋' });
    addBtn.setAttribute('aria-label', 'Add a playlist from a URL');
    addBtn.onclick = () => new AddPlaylistModal(this.app, this.plugin).open();

    this.plEl = root.createDiv({ cls: 'mp-playlists' });
    this.renderPlaylists();

    this.statusEl = root.createDiv({ cls: 'mp-status' });
  }

  renderPlaylists() {
    if (!this.plEl) return;
    this.plEl.empty();
    const list = this.plugin.settings.playlists.filter((p) => p && p.uri);

    if (list.length === 0) {
      this.plEl.createDiv({
        cls: 'mp-empty',
        text: 'Press ＋ and paste a Spotify URL',
      });
      return;
    }

    list.forEach((p) => {
      const row = this.plEl.createDiv({ cls: 'mp-pl-row' });

      const btn = row.createEl('button', { cls: 'mp-pl-btn' });
      btn.createSpan({ cls: 'mp-pl-icon', text: '▶' });
      btn.createSpan({ cls: 'mp-pl-name', text: p.name || p.uri });
      btn.onclick = () => this.plugin.playUri(p.uri, p.name);

      const del = row.createEl('button', { cls: 'mp-pl-del', text: '×' });
      del.setAttribute('aria-label', 'Remove');
      del.onclick = async (ev) => {
        ev.stopPropagation();
        const idx = this.plugin.settings.playlists.indexOf(p);
        if (idx >= 0) {
          this.plugin.settings.playlists.splice(idx, 1);
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        }
      };
    });
  }

  /** Send a command, then re-read the status shortly after. */
  async act(path, method, body) {
    try {
      await callApi(this.plugin.settings.serverUrl, path, method, body);
      window.setTimeout(() => this.refresh(), 350);
    } catch (e) {
      new Notice('Mini Player: ' + e.message);
    }
  }

  async refresh() {
    let st = null;
    try {
      const res = await callApi(this.plugin.settings.serverUrl, '/status');
      st = res.json;
    } catch (e) {
      this.status = null;
      this.setDisconnected();
      return;
    }
    this.status = st;
    this.render(st);
  }

  setDisconnected() {
    this.statusEl.style.display = '';
    this.statusEl.empty();
    this.statusEl.createSpan({ cls: 'mp-dot mp-dot-off' });
    this.statusEl.createSpan({ cls: 'mp-status-text', text: 'Not connected' });
    const help = this.statusEl.createEl('button', { cls: 'mp-mini-btn', text: '?' });
    help.setAttribute('aria-label', 'Setup guide');
    help.onclick = () => new SetupModal(this.app, this.plugin).open();

    this.titleEl.setText('—');
    this.artistEl.setText('');
    this.playBtn.setText('▶');
    this.artImgEl.style.display = 'none';
    this.artPlaceholderEl.style.display = '';
  }

  render(st) {
    const t = st.track;

    if (t) {
      this.titleEl.setText(t.name || '—');
      this.artistEl.setText(Array.isArray(t.artist_names) ? t.artist_names.join(', ') : '');
      if (t.album_cover_url) {
        if (this.artImgEl.src !== t.album_cover_url) this.artImgEl.src = t.album_cover_url;
        this.artImgEl.style.display = '';
        this.artPlaceholderEl.style.display = 'none';
      } else {
        this.artImgEl.style.display = 'none';
        this.artPlaceholderEl.style.display = '';
      }
      this.posEl.setText(fmtTime(t.position));
      this.durEl.setText(fmtTime(t.duration));
      if (!this.seeking && t.duration > 0) {
        this.seekEl.value = String(Math.floor((t.position / t.duration) * 1000));
      }
    } else {
      this.titleEl.setText('Nothing playing');
      this.artistEl.setText('');
      this.posEl.setText('0:00');
      this.durEl.setText('0:00');
      if (!this.seeking) this.seekEl.value = '0';
      this.artImgEl.style.display = 'none';
      this.artPlaceholderEl.style.display = '';
    }

    const playing = t && !st.paused && !st.stopped;
    this.playBtn.setText(playing ? '⏸' : '▶');

    if (!this.volumeDragging && typeof st.volume === 'number') {
      const steps = st.volume_steps || 100;
      this.volEl.value = String(Math.round((st.volume / steps) * 100));
    }

    // Say nothing while things are fine; the same line every 3 seconds is just noise.
    // Only buffering and a lost connection are worth reporting.
    this.statusEl.empty();
    if (st.buffering) {
      this.statusEl.style.display = '';
      this.statusEl.createSpan({ cls: 'mp-dot mp-dot-play' });
      this.statusEl.createSpan({ text: 'Buffering' });
    } else {
      this.statusEl.style.display = 'none';
    }
  }
}

/* ────────────────────────────── Settings ────────────────────────────── */

class MiniPlayerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('go-librespot URL')
      .setDesc('Address of the API server. Default: http://127.0.0.1:3678')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:3678')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (v) => {
            this.plugin.settings.serverUrl = v.trim() || DEFAULT_SETTINGS.serverUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Connection')
      .setDesc('Check whether go-librespot is reachable')
      .addButton((b) =>
        b.setButtonText('Test').onClick(async () => {
          try {
            const res = await callApi(this.plugin.settings.serverUrl, '/status');
            new Notice('Connected: ' + (res.json.device_name || 'go-librespot'));
          } catch (e) {
            new Notice('Not connected: ' + e.message);
          }
        })
      )
      .addButton((b) =>
        b.setButtonText('Setup guide').onClick(() => {
          new SetupModal(this.app, this.plugin).open();
        })
      );

    new Setting(containerEl).setName('Playlists').setHeading();

    new Setting(containerEl)
      .setName('Add a playlist')
      .setDesc('A Spotify URL can be pasted as-is')
      .addButton((b) =>
        b.setButtonText('Add from URL').setCta().onClick(() => {
          new AddPlaylistModal(this.app, this.plugin, () => this.display()).open();
        })
      );

    if (this.plugin.settings.playlists.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: 'Nothing saved yet.',
      });
    }

    this.plugin.settings.playlists.forEach((p, i) => {
      const s = new Setting(containerEl)
        .addText((t) =>
          t
            .setPlaceholder('Display name')
            .setValue(p.name || '')
            .onChange(async (v) => {
              this.plugin.settings.playlists[i].name = v;
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
            })
        )
        .addText((t) =>
          t
            .setPlaceholder('Paste a URL as-is')
            .setValue(p.uri || '')
            .onChange(async (v) => {
              const u = normalizeSpotifyUri(v);
              this.plugin.settings.playlists[i].uri = u;
              // Show the converted URI so it is visible that the paste worked.
              if (u && u !== v) t.setValue(u);
              await this.plugin.saveSettings();
              this.plugin.refreshViews();
            })
        )
        .addExtraButton((b) =>
          b.setIcon('trash').setTooltip('Remove').onClick(async () => {
            this.plugin.settings.playlists.splice(i, 1);
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
            this.display();
          })
        );
      s.settingEl.addClass('mp-setting-row');
    });
  }
}

/* ────────────────────────────── Plugin ────────────────────────────── */

module.exports = class MiniPlayerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_MINI_PLAYER, (leaf) => new MiniPlayerView(leaf, this));

    this.addRibbonIcon('play-circle', 'Mini Player', () => this.activateView());

    this.addCommand({
      id: 'open-mini-player',
      name: 'Open mini player',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'playpause',
      name: 'Play or pause',
      callback: () => this.simpleAct('/player/playpause'),
    });

    this.addCommand({
      id: 'next-track',
      name: 'Next track',
      callback: () => this.simpleAct('/player/next'),
    });

    this.addCommand({
      id: 'previous-track',
      name: 'Previous track',
      callback: () => this.simpleAct('/player/prev'),
    });

    this.addCommand({
      id: 'play-saved-playlist',
      name: 'Play a saved playlist',
      callback: () => new SavedPlaylistModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'add-playlist-from-url',
      name: 'Add a playlist from a URL',
      callback: () => new AddPlaylistModal(this.app, this).open(),
    });

    this.addSettingTab(new MiniPlayerSettingTab(this.app, this));
  }

  onunload() {}

  async simpleAct(path) {
    try {
      await callApi(this.settings.serverUrl, path, 'POST');
      this.refreshViews(true);
    } catch (e) {
      new Notice('Mini Player: ' + e.message);
    }
  }

  async playUri(uri, name) {
    try {
      await callApi(this.settings.serverUrl, '/player/play', 'POST', { uri, paused: false });
      if (name) new Notice('Playing: ' + name);
      this.refreshViews(true);
    } catch (e) {
      new Notice('Could not play: ' + e.message);
    }
  }

  /** Look up a display name when the user leaves it blank. */
  async lookupName(uri) {
    const m = uri.match(/^spotify:(playlist|album|artist|track):([A-Za-z0-9]+)$/);
    if (!m) return '';
    const kind = { playlist: 'playlists', album: 'albums', artist: 'artists', track: 'tracks' }[m[1]];
    try {
      const data = await webApi(this.settings.serverUrl, '/' + kind + '/' + m[2]);
      return data.name || '';
    } catch (e) {
      return '';
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MINI_PLAYER)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_MINI_PLAYER, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshViews(statusOnly) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_PLAYER)) {
      const v = leaf.view;
      if (!v) continue;
      if (statusOnly) {
        if (v.refresh) window.setTimeout(() => v.refresh(), 350);
      } else if (v.renderPlaylists) {
        v.renderPlaylists();
      }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.playlists)) this.settings.playlists = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
