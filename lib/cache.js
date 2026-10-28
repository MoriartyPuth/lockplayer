import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lockplayer']);
const USER_AGENT = 'Lockplayer/1.0 (https://github.com/MoriartyPuth/lockplayer)';

const hash = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, text, -1);

export function cachePath(kind, key, extension = '') {
    const dir = GLib.build_filenamev([CACHE_DIR, kind]);
    GLib.mkdir_with_parents(dir, 0o700);
    return GLib.build_filenamev([dir, hash(key) + extension]);
}

export class Http {
    constructor() {
        this._session = new Soup.Session({timeout: 15, user_agent: USER_AGENT});
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }

    // GET url (with query params) and resolve to its bytes, or null on any
    // failure or a non-200 status.
    get(url, params = null) {
        const message = params
            ? Soup.Message.new_from_encoded_form('GET', url, Soup.form_encode_hash(params))
            : Soup.Message.new('GET', url);
        if (!message)
            return Promise.resolve(null);
        return new Promise(resolve => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    resolve(message.get_status() === Soup.Status.OK ? bytes : null);
                } catch {
                    resolve(null);
                }
            });
        });
    }
}

// Album art as a local file path: file:// URLs are used as they are, remote
// ones are downloaded once into the cache.
export async function artPath(http, url) {
    if (!url)
        return null;
    if (url.startsWith('file://'))
        return Gio.File.new_for_uri(url).get_path();
    if (!/^https?:\/\//.test(url))
        return null;

    const path = cachePath('art', url);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return path;
    const bytes = await http.get(url);
    if (!bytes || bytes.get_size() === 0)
        return null;
    Gio.File.new_for_path(path).replace_contents(bytes.toArray(), null, false, Gio.FileCreateFlags.PRIVATE, null);
    return path;
}
