import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Http} from './lib/cache.js';
import {NowPlayingCard} from './lib/card.js';
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
        this._queueAttach();
    }

    disable() {
        if (this._attachId)
            GLib.source_remove(this._attachId);
        this._attachId = 0;
        Main.screenShield._lockDialogGroup.disconnectObject(this);
        Main.screenShield.disconnectObject(this);
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
    }
}
