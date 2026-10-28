import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const toHex = color => `#${[color.red, color.green, color.blue]
    .map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;

export default class LockplayerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const toggle = (group, key, title, subtitle = null) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const card = new Adw.PreferencesGroup({title: 'Card'});
        page.add(card);
        toggle(card, 'big-artwork', 'Large album art', 'Clicking the cover on the lock screen toggles this too');
        toggle(card, 'notifications-under-clock', 'Notifications under the clock',
            'Instead of at the bottom of the screen');

        const opacity = new Adw.SpinRow({
            title: 'Background opacity',
            digits: 2,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1, step_increment: 0.05}),
        });
        settings.bind('card-opacity', opacity, 'value', Gio.SettingsBindFlags.DEFAULT);
        card.add(opacity);

        const accentButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string('accent-color')))
            accentButton.rgba = rgba;
        accentButton.connect('notify::rgba', () => settings.set_string('accent-color', toHex(accentButton.rgba)));
        const accent = new Adw.ActionRow({title: 'Accent color', activatable_widget: accentButton});
        accent.add_suffix(accentButton);
        card.add(accent);

        const lyrics = new Adw.PreferencesGroup({
            title: 'Lyrics',
            description: 'Synced lyrics come from lrclib.net and are cached in ~/.cache/lockplayer.',
        });
        page.add(lyrics);
        toggle(lyrics, 'show-lyrics', 'Show lyrics');
        toggle(lyrics, 'online-lyrics', 'Look up lyrics online');
    }
}
