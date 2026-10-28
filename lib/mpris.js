import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
// playerctld mirrors whichever player is active; listing it too would duplicate it.
const IGNORED = new Set([`${MPRIS_PREFIX}playerctld`]);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause"/>
  <method name="Next"/>
  <method name="Previous"/>
  <signal name="Seeked"><arg type="x" name="Position"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="CanGoNext" type="b" access="read"/>
  <property name="CanGoPrevious" type="b" access="read"/>
</interface>
</node>`);

const unpack = (metadata, key) => metadata?.[key]?.deepUnpack();

// Talks to MPRIS players over D-Bus directly rather than through GNOME's
// MprisSource, so other extensions patching that can't hide players from us,
// and so the album, length and position are available.
export const MprisWatcher = GObject.registerClass({
    Signals: {
        'changed': {},
        'seeked': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class LockplayerMprisWatcher extends GObject.Object {
    constructor() {
        super();
        this._players = new Map();
        this._bus = Gio.DBus.session;

        this._ownerChangedId = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', MPRIS_PREFIX.slice(0, -1), Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, null, (bus, res) => {
                try {
                    const [names] = bus.call_finish(res).deepUnpack();
                    names.filter(name => name.startsWith(MPRIS_PREFIX)).forEach(name => this._addPlayer(name));
                } catch (e) {
                    logError(e, 'Lockplayer: listing MPRIS players');
                }
            });
    }

    destroy() {
        this._bus.signal_unsubscribe(this._ownerChangedId);
        [...this._players.keys()].forEach(name => this._removePlayer(name));
    }

    // The player to show: the most recently started one that is playing,
    // else the most recently active one that is paused on a track.
    get active() {
        const players = [...this._players.values()].filter(p => p.ready && p.title);
        const recent = (a, b) => b.lastActive - a.lastActive;
        return players.filter(p => p.status === 'Playing').sort(recent)[0] ??
            players.filter(p => p.status === 'Paused').sort(recent)[0] ?? null;
    }

    playPause() {
        this.active?.proxy.PlayPauseAsync().catch(() => {});
    }

    next() {
        this.active?.proxy.NextAsync().catch(() => {});
    }

    previous() {
        this.active?.proxy.PreviousAsync().catch(() => {});
    }

    // Position isn't signalled by MPRIS, so it has to be asked for. Seconds.
    getPosition() {
        const player = this.active;
        if (!player)
            return Promise.resolve(0);
        return new Promise(resolve => {
            this._bus.call(player.name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                null, Gio.DBusCallFlags.NONE, 1000, null, (bus, res) => {
                    try {
                        const [value] = bus.call_finish(res).deepUnpack();
                        resolve(value.deepUnpack() / 1e6);
                    } catch {
                        resolve(null);
                    }
                });
        });
    }

    _addPlayer(name) {
        if (IGNORED.has(name) || this._players.has(name))
            return;
        const player = {name, ready: false, lastActive: 0};
        this._players.set(name, player);
        player.proxy = new PlayerProxy(this._bus, name, MPRIS_PATH, (proxy, error) => {
            if (error || this._players.get(name) !== player)
                return;
            player.propsId = proxy.connect('g-properties-changed', () => this._update(player));
            player.seekedId = proxy.connectSignal('Seeked', (_p, _s, [position]) => {
                if (player === this.active)
                    this.emit('seeked', position / 1e6);
            });
            player.ready = true;
            this._update(player);
        });
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        if (player.propsId)
            player.proxy.disconnect(player.propsId);
        if (player.seekedId)
            player.proxy.disconnectSignal(player.seekedId);
        this.emit('changed');
    }

    _update(player) {
        const {proxy} = player;
        const metadata = proxy.Metadata ?? {};
        const status = proxy.PlaybackStatus;
        if (status === 'Playing' && player.status !== 'Playing')
            player.lastActive = GLib.get_monotonic_time();

        const artists = unpack(metadata, 'xesam:artist');
        Object.assign(player, {
            status,
            title: unpack(metadata, 'xesam:title') ?? '',
            artists: Array.isArray(artists) ? artists.filter(a => typeof a === 'string' && a) : [],
            album: unpack(metadata, 'xesam:album') ?? '',
            artUrl: unpack(metadata, 'mpris:artUrl') ?? '',
            // Some players (Spotube) report 0; callers fall back to the lyrics' duration.
            length: (Number(unpack(metadata, 'mpris:length')) || 0) / 1e6,
            canGoNext: proxy.CanGoNext ?? true,
            canGoPrevious: proxy.CanGoPrevious ?? true,
        });
        this.emit('changed');
    }
});
