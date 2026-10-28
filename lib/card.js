import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {artPath} from './cache.js';
import {currentLine, fetchLyrics} from './lyrics.js';

const TICK_MS = 250;
const RESYNC_MS = 2000;
const LYRIC_ROWS = 5; // odd: the current line sits in the middle
const SCROLL_MS = 260;
const ART_SMALL = 96;
const ART_BIG = 200;

const formatTime = seconds => {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const trackKey = track => track && [track.name, track.title, track.artists.join('/'), track.album].join('\n');

// The now-playing card shown under the lock screen clock: art, title,
// artist · album, progress, controls and synced lyrics. Hidden when nothing
// is playing or paused on a track.
export const NowPlayingCard = GObject.registerClass(
class LockplayerCard extends St.BoxLayout {
    constructor(watcher, http, settings) {
        super({
            style_class: 'lockplayer-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._watcher = watcher;
        this._http = http;
        this._settings = settings;
        this._position = 0;
        this._positionAt = 0;
        this._lyrics = null;
        this._lyricIndex = -2;

        this._buildMain();
        this._buildLyrics();

        watcher.connectObject(
            'changed', () => this._sync(),
            'seeked', (_w, position) => this._setPosition(position),
            this);
        settings.connectObject('changed', () => this._applySettings(), this);
        this.connect('notify::mapped', () => this._updateTicking());
        this.connect('destroy', () => this._stopTicking());

        this._applySettings();
        this._sync();
    }

    _buildMain() {
        const row = new St.BoxLayout({style_class: 'lockplayer-row'});

        this._art = new St.Button({
            style_class: 'lockplayer-art',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'audio-x-generic-symbolic', style_class: 'lockplayer-art-placeholder'}),
        });
        this._art.connect('clicked', () =>
            this._settings.set_boolean('big-artwork', !this._settings.get_boolean('big-artwork')));
        row.add_child(this._art);

        const info = new St.BoxLayout({
            style_class: 'lockplayer-info',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'lockplayer-title'});
        this._subtitle = new St.Label({style_class: 'lockplayer-subtitle'});
        for (const label of [this._title, this._subtitle])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(this._title);
        info.add_child(this._subtitle);

        const progress = new St.BoxLayout({style_class: 'lockplayer-progress'});
        this._elapsed = new St.Label({style_class: 'lockplayer-time', y_align: Clutter.ActorAlign.CENTER});
        this._track = new St.Widget({style_class: 'lockplayer-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'lockplayer-fill'});
        this._track.add_child(this._fill);
        this._total = new St.Label({style_class: 'lockplayer-time', y_align: Clutter.ActorAlign.CENTER});
        progress.add_child(this._elapsed);
        progress.add_child(this._track);
        progress.add_child(this._total);
        info.add_child(progress);

        const controls = new St.BoxLayout({style_class: 'lockplayer-controls', x_align: Clutter.ActorAlign.CENTER});
        const button = (icon, action, extra = '') => {
            const b = new St.Button({
                style_class: `lockplayer-button ${extra}`,
                child: new St.Icon({icon_name: icon}),
                can_focus: true,
            });
            b.connect('clicked', action);
            controls.add_child(b);
            return b;
        };
        this._prev = button('media-skip-backward-symbolic', () => this._watcher.previous());
        this._play = button('media-playback-start-symbolic', () => this._watcher.playPause(), 'lockplayer-play');
        this._next = button('media-skip-forward-symbolic', () => this._watcher.next());
        this._lyricsButton = button('format-justify-left-symbolic',
            () => this._settings.set_boolean('show-lyrics', !this._settings.get_boolean('show-lyrics')),
            'lockplayer-lyrics-toggle');
        info.add_child(controls);

        row.add_child(info);
        this.add_child(row);
    }

    _buildLyrics() {
        // The rows live in a clipped box so the scroll animation can slide
        // them up by a line without spilling over the card.
        this._lyricsBox = new St.Widget({
            style_class: 'lockplayer-lyrics',
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
            visible: false,
        });
        this._lyricRows = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rows = Array.from({length: LYRIC_ROWS}, () => {
            const label = new St.Label({style_class: 'lockplayer-lyric', x_align: Clutter.ActorAlign.CENTER});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._lyricRows.add_child(label);
            return label;
        });
        this._lyricsBox.add_child(this._lyricRows);
        this.add_child(this._lyricsBox);
    }

    _applySettings() {
        const accent = this._settings.get_string('accent-color');
        const opacity = this._settings.get_double('card-opacity');
        this.set_style(`background-color: rgba(40, 40, 40, ${opacity});`);
        this._fill.set_style(`background-color: ${accent};`);
        this._rows[LYRIC_ROWS >> 1].set_style(`color: ${accent};`);

        const size = this._settings.get_boolean('big-artwork') ? ART_BIG : ART_SMALL;
        this._art.ease({width: size, height: size, duration: SCROLL_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._lyricsButton.checked = this._settings.get_boolean('show-lyrics');
        this._updateLyricsVisibility();
    }

    _sync() {
        const track = this._watcher.active;
        this.visible = !!track;
        this._updateTicking();
        if (!track)
            return;

        this._title.text = track.title;
        this._subtitle.text = [track.artists.join(', '), track.album].filter(Boolean).join(' · ');
        this._play.child.icon_name = track.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = track.canGoPrevious;
        this._next.reactive = track.canGoNext;
        this._prev.opacity = track.canGoPrevious ? 255 : 100;
        this._next.opacity = track.canGoNext ? 255 : 100;

        const key = trackKey(track);
        if (key !== this._trackKey) {
            this._trackKey = key;
            this._lyrics = null;
            this._lyricIndex = -2;
            this._updateLyricsVisibility();
            this._loadArt(track, key);
            this._loadLyrics(track, key);
            this._resync();
        }
        this._tick();
    }

    async _loadArt(track, key) {
        this._setArt(null);
        const path = await artPath(this._http, track.artUrl);
        if (key === this._trackKey)
            this._setArt(path);
    }

    _setArt(path) {
        this._art.child.visible = !path;
        this._art.set_style(path
            ? `background-image: url("${GLib.filename_to_uri(path, null)}"); background-size: cover;`
            : null);
    }

    async _loadLyrics(track, key) {
        if (!this._settings.get_boolean('online-lyrics'))
            return;
        const lyrics = await fetchLyrics(this._http, track).catch(() => null);
        if (key !== this._trackKey)
            return;
        this._lyrics = lyrics;
        this._updateLyricsVisibility();
        this._tick();
    }

    _updateLyricsVisibility() {
        this._lyricsBox.visible = !!this._lyrics && this._settings.get_boolean('show-lyrics');
        this._lyricsButton.visible = !!this._lyrics;
        this._lyricIndex = -2;
    }

    // Seconds into the track: the last known position, advanced by the time
    // since while playing.
    get _now() {
        const playing = this._watcher.active?.status === 'Playing';
        const elapsed = playing ? (GLib.get_monotonic_time() - this._positionAt) / 1e6 : 0;
        return this._position + elapsed;
    }

    get _length() {
        return this._watcher.active?.length || this._lyrics?.duration || 0;
    }

    _setPosition(position) {
        if (position === null)
            return;
        this._position = position;
        this._positionAt = GLib.get_monotonic_time();
        this._tick();
    }

    async _resync() {
        this._setPosition(await this._watcher.getPosition());
    }

    _updateTicking() {
        const wanted = this.mapped && this.visible;
        if (wanted && !this._tickId) {
            this._resync();
            let sinceResync = 0;
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
                sinceResync += TICK_MS;
                if (sinceResync >= RESYNC_MS) {
                    sinceResync = 0;
                    this._resync();
                }
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted) {
            this._stopTicking();
        }
    }

    _stopTicking() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _tick() {
        // Measuring the bar or rows off-stage makes St complain; ticking
        // restarts as soon as the card is mapped.
        if (!this.mapped)
            return;
        const now = this._now;
        const length = this._length;
        this._elapsed.text = formatTime(now);
        this._total.text = length ? formatTime(length) : '';
        const fraction = length ? Math.min(1, now / length) : 0;
        this._fill.width = Math.round(this._track.width * fraction);
        this._fill.height = this._track.height;
        this._updateLyrics(now, length);
    }

    _updateLyrics(now, length) {
        if (!this._lyricsBox.visible)
            return;
        let lines, index;
        if (this._lyrics.synced?.length) {
            lines = this._lyrics.synced.map(l => l.text);
            index = currentLine(this._lyrics.synced, now);
        } else {
            // Plain lyrics have no timing: step through them evenly when the
            // length is known, otherwise show the opening lines.
            lines = this._lyrics.plain.split('\n').filter(l => l.trim());
            index = length ? Math.floor(Math.min(0.999, now / length) * lines.length) : LYRIC_ROWS >> 1;
        }
        if (index === this._lyricIndex)
            return;
        const scrolled = index === this._lyricIndex + 1;
        this._lyricIndex = index;

        const half = LYRIC_ROWS >> 1;
        this._rows.forEach((row, i) => {
            const line = lines[index - half + i];
            row.text = line === undefined ? '' : line || '♪';
        });
        if (scrolled) {
            this._lyricRows.translation_y = this._rows[0].height;
            this._lyricRows.ease({translation_y: 0, duration: SCROLL_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }
});
