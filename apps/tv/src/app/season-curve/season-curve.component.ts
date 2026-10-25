import { Component, Input, OnChanges } from '@angular/core';
import { ImdbSeason } from '../imdb.service';

// A season at a glance: one bar per episode, as tall as its IMDb rating, the
// season's mean as a dashed line. `current` marks the episode a page is about,
// `highlight` lights the focused episode card's bar. Not focusable.
@Component({
  selector: 'season-curve',
  templateUrl: './season-curve.component.html',
  styleUrls: ['./season-curve.component.scss']
})
export class SeasonCurveComponent implements OnChanges {

  // the season's episodes in order (the catalog's numbers), ratings from IMDb
  @Input() episodes:{ episodeNumber:number }[] = [];
  @Input() imdb:ImdbSeason | null = null;
  @Input() current:number | null = null;
  @Input() highlight:number | null = null;

  bars:{ episode:number, rating:number | null, height:number }[] = [];
  averageAt = 0;
  label = '';

  ngOnChanges(): void {
    let ratings = new Map((this.imdb?.episodes || []).map(e => [e.episode, e.rating]));
    let rated = Array.from(ratings.values()).filter(r => r);
    // ratings bunch up between 7 and 9: start the scale a point under the lowest
    let low = rated.length ? Math.max(0, Math.floor(Math.min(...rated)) - 1) : 0;
    let scale = (r:number) => Math.max(0.06, (r - low) / (10 - low));

    this.bars = this.episodes.map(ep => {
      let rating = ratings.get(ep.episodeNumber) || null;
      return { episode: ep.episodeNumber, rating, height: rating ? scale(rating) * 100 : 0 };
    });
    this.averageAt = this.imdb?.rating ? scale(this.imdb.rating) * 100 : 0;

    let best = this.bars.reduce((top, b) => b.rating && (!top || b.rating > top.rating) ? b : top, null);
    this.label = this.imdb?.rating
      ? `IMDb season average ${this.imdb.rating}` + (best ? `, best episode ${best.episode} at ${best.rating}` : '')
      : 'No IMDb ratings for this season yet';
  }

  trackBar(_:number, bar) {
    return bar.episode;
  }
}
