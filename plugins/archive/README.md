# Internet Archive

The reference `sources.search` plugin (docs/search-plan.md §3): the Internet Archive's moving-image collection (public-domain and Creative Commons films) in the dashboard's Search, and in a movie's Play (`play.collect`, by title and year).

- **Search**: `advancedsearch.php` with every keyword in the title (`title:(night AND living AND dead) AND mediatype:movies`), most downloaded first, 6 films a page; each film's `metadata/<id>` read for its video files.
- **Files**: h.264 MP4 / Matroska and WebM only (the plain "MPEG4" format is MPEG-4 Part 2, XviD: no browser decodes it), no 512 kb previews, the sharpest 3 per film, as `http` sources (`archive.org/download/<id>/<file>`, which redirects to a numbered `*.archive.org` host: both in `network`).
- No account, no key. Films keep the license the Internet Archive lists for them.

Try it: copy this folder into `<config>/plugins-dev/` with `plugins.developerMode` on, or pack it with `npm run pack:plugin -- plugins/archive`. Which repository it goes to (the official one is a fit: no adult or pirated content) is the maintainer's call.
