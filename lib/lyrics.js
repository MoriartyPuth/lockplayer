import GLib from 'gi://GLib';

import {cachePath} from './cache.js';

const LRCLIB = 'https://lrclib.net/api/';
// A miss is remembered this long so a song without lyrics isn't re-queried
// on every lock.
const MISS_TTL_US = 24 * 60 * 60 * 1e6;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// '[01:02.50] line' (one or more timestamps per line) -> sorted [{time, text}]
export function parseLrc(lrc) {
    const lines = [];
    for (const raw of lrc.split('\n')) {
        const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
        if (!stamps.length)
            continue;
        const text = raw.slice(stamps.at(-1).index + stamps.at(-1)[0].length).trim();
        for (const [, min, sec] of stamps)
            lines.push({time: Number(min) * 60 + Number(sec), text});
    }
    return lines.sort((a, b) => a.time - b.time);
}

// Lyrics for a track as {synced: [{time, text}] | null, plain: string | null,
// duration: seconds | null}, or null when LRCLIB has nothing. Cached on disk;
// rejects (uncached) when LRCLIB can't be reached.
export async function fetchLyrics(http, track) {
    const key = [track.title, track.artists.join(', '), track.album].join('\n');
    const path = cachePath('lyrics', key, '.json');

    try {
        const [, contents] = GLib.file_get_contents(path);
        const cached = JSON.parse(decoder.decode(contents));
        if (cached.found || GLib.get_real_time() - cached.at < MISS_TTL_US)
            return cached.found ? cached.lyrics : null;
    } catch {}

    const lyrics = await query(http, track);
    GLib.file_set_contents(path, encoder.encode(JSON.stringify({found: !!lyrics, at: GLib.get_real_time(), lyrics})));
    return lyrics;
}

async function query(http, track) {
    const artist = track.artists.join(', ');
    const toLyrics = hit => hit && (hit.syncedLyrics || hit.plainLyrics) ? {
        synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
        plain: hit.plainLyrics ?? null,
        duration: hit.duration ?? null,
    } : null;

    // Exact match first; it needs the length, which some players don't report.
    if (track.length > 0) {
        const bytes = await http.get(`${LRCLIB}get`, {
            track_name: track.title,
            artist_name: artist,
            album_name: track.album,
            duration: String(Math.round(track.length)),
        });
        const exact = bytes && toLyrics(JSON.parse(decoder.decode(bytes.toArray())));
        if (exact)
            return exact;
    }

    // Unreachable or erroring (LRCLIB returns 503 when overloaded): throw so
    // the failure isn't cached as "no lyrics" like a real empty result.
    const bytes = await http.get(`${LRCLIB}search`, {q: `${track.title} ${artist}`.trim()});
    if (!bytes)
        throw new Error('LRCLIB search failed');
    const results = JSON.parse(decoder.decode(bytes.toArray()));
    if (!Array.isArray(results) || !results.length)
        return null;

    // Prefer synced lyrics, then the closest length when we know it.
    const title = track.title.toLowerCase();
    const score = hit =>
        (hit.syncedLyrics ? 0 : 1000) +
        (hit.trackName?.toLowerCase() === title ? 0 : 500) +
        (track.length > 0 ? Math.abs((hit.duration ?? 0) - track.length) : 0);
    return toLyrics(results.sort((a, b) => score(a) - score(b))[0]);
}

// Index of the line being sung at `position` seconds, or -1 before the first.
export function currentLine(lines, position) {
    let low = 0, high = lines.length - 1, found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].time <= position) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}
