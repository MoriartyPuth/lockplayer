import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Http} from './lib/cache.js';
import {NowPlayingCard} from './lib/card.js';
import {ColumnLayout} from './lib/layout.js';
import {MprisWatcher} from './lib/mpris.js';

// Runs in the user and unlock-dialog session modes so it stays enabled while
// locked. The unlock dialog is created on lock and destroyed on unlock; the
// card goes into its clock column, which GNOME already fades out when the
// password prompt appears, and is destroyed along with the dialog.
export default class LockplayerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._watcher = new MprisWatcher();
        this._http = new Http();

        Main.screenShield._lockDialogGroup.connectObject('child-added', () => this._queueAttach(), this);
        Main.screenShield.connectObject('locked-changed', () => this._queueAttach(), this);
        this._settings.connectObject(
            'changed::notifications-under-clock', () => this._syncLayout(),
            'changed::hide-gnome-media', () => this._syncGnomeMedia(),
            this);
        this._queueAttach();
    }

    disable() {
        if (this._attachId)
            GLib.source_remove(this._attachId);
        this._attachId = 0;
        Main.screenShield._lockDialogGroup.disconnectObject(this);
        Main.screenShield.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._restoreLayout();
        this._restoreGnomeMedia();
        this._card?.destroy();
        this._card = null;
        this._http.destroy();
        this._watcher.destroy();
        this._http = null;
        this._watcher = null;
        this._settings = null;
    }

    // The dialog adds itself to the group before building its clock, so wait
    // until the current construction has finished.
    _queueAttach() {
        if (this._attachId)
            return;
        this._attachId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._attachId = 0;
            this._attach();
            return GLib.SOURCE_REMOVE;
        });
    }

    _attach() {
        const clock = Main.screenShield._dialog?._clock;
        if (!clock || this._card?.get_parent() === clock)
            return;

        this._card?.destroy();
        this._card = new NowPlayingCard(this._watcher, this._http, this._settings);
        this._card.connect('destroy', card => {
            if (this._card === card)
                this._card = null;
        });
        // Under the time and date, above the "click to unlock" hint.
        clock.insert_child_at_index(this._card, 2);
        this._syncLayout();
        this._syncGnomeMedia();
    }

    // GNOME's notifications box keeps one media card per MPRIS player in
    // _players; hide them (re-checking whenever a player comes or goes, after
    // GNOME's own handler has added its card) since our card replaces them.
    _syncGnomeMedia() {
        const box = Main.screenShield._dialog?._notificationsBox;
        if (!box?._players)
            return;

        if (this._mediaBox !== box) {
            this._restoreGnomeMedia();
            this._mediaBox = box;
            box._mediaSource?.connectObject(
                'player-added', () => this._syncGnomeMedia(),
                'player-removed', () => this._syncGnomeMedia(),
                this);
            box.connectObject('destroy', () => (this._mediaBox = null), this);
        }

        const hide = this._settings.get_boolean('hide-gnome-media');
        for (const message of box._players.values())
            message.visible = !hide;
        box._updateVisibility?.();
    }

    _restoreGnomeMedia() {
        const box = this._mediaBox;
        if (!box)
            return;
        this._mediaBox = null;
        box._mediaSource?.disconnectObject(this);
        box.disconnectObject(this);
        for (const message of box._players?.values() ?? [])
            message.visible = true;
        box._updateVisibility?.();
    }

    // Swap GNOME's lock screen layout for one that stacks the notifications
    // under the clock column, keeping the original to put back.
    _syncLayout() {
        const dialog = Main.screenShield._dialog;
        const column = dialog?._stack?.get_parent();
        if (!column)
            return;

        const wanted = this._settings.get_boolean('notifications-under-clock');
        if (wanted && !this._layout) {
            this._layout = {column, original: column.layout_manager};
            column.layout_manager = new ColumnLayout(dialog._stack, dialog._notificationsBox, dialog._otherUserButton);
            column.connectObject('destroy', () => (this._layout = null), this);
        } else if (!wanted) {
            this._restoreLayout();
        }
    }

    _restoreLayout() {
        if (!this._layout)
            return;
        const {column, original} = this._layout;
        this._layout = null;
        column.disconnectObject(this);
        column.layout_manager = original;
    }
}
