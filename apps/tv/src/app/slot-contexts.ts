import { Profile } from './profiles.service';
import { ProfileContext, TitleRef } from './ui/public-api';

// Builders of the slots' contexts (ui/slots/slots.ts) from the core's data:
// read-only snapshots handed to contributions, never a page or a service.

export function profileContext(profile:Profile | null):ProfileContext {
  return { id: profile?.id || '', name: profile?.name || '', kids: !!profile?.isKid };
}

// a TMDB movie / show
export function titleRef(item:any, imdbId?:string | null):TitleRef {
  let date = item?.release_date || item?.first_air_date || '';
  return {
    tmdbId: Number(item?.id) || 0,
    imdbId: imdbId ?? item?.imdb_id ?? item?.external_ids?.imdb_id ?? null,
    title: item?.title || item?.original_title || item?.name || '',
    year: date ? String(date).slice(0, 4) : null,
  };
}
