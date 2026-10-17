// Output formats for a tracklist: JSON, and the plain-text lines the admin's
// tracklist box already parses (`04:32 Artist - Title https://…`).

export function toJson(tracklist) {
  return JSON.stringify(tracklist, null, 2) + '\n';
}

export function toText(tracklist) {
  return tracklist.tracks
    .map((t) => {
      const name = t.artist ? `${t.artist} - ${t.title}` : t.title;
      return [t.time, name, t.url].filter(Boolean).join(' ');
    })
    .join('\n') + '\n';
}
