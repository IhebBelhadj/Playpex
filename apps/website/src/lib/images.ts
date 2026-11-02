// Every picture the site draws (screens, posters, the poster wall, the Sintel loop), by file name without its
// extension. Vite fingerprints them and adds the base path, for the pages and for the scripts that load them
// into the dither shader.
const files = import.meta.glob<string>('../assets/img/*.{jpg,png,webp,mp4}', { eager: true, query: '?url', import: 'default' });

export const IMG: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.')), url]),
);
