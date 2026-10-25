import { Profile } from './profiles.service';
import { TitleItem, displayTitle } from './movies.service';
import { ProfileContext, TitleRef } from './ui/public-api';

// Builders of the slots' contexts (ui/slots/slots.ts) from the core's data:
// read-only snapshots handed to contributions, never a page or a service.

export function profileContext(profile:Profile | null):ProfileContext {
  return { id: profile?.id || '', name: profile?.name || '', kids: !!profile?.isKid };
}

// a movie / show of the catalog
export function titleRef(item:Partial<TitleItem> | null, imdbId?:string | null):TitleRef {
  return {
    tmdbId: Number(item?.tmdbId) || 0,
    imdbId: imdbId ?? item?.imdbId ?? null,
    title: item?.title || displayTitle(item),
    year: item?.year || null,
  };
}
