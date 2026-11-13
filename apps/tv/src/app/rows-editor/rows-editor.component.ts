import { Component, Input, OnChanges, OnDestroy } from '@angular/core';
import { Subject, Subscription, concatMap, debounceTime, filter } from 'rxjs';
import { SectionId } from '../catalog';
import { FocusEngine } from '../movement/movement';
import { RowEntry, SectionRowsService } from '../sections.service';
import { Toasts } from '../ui/public-api';

export const SECTION_NAMES:{ [section in SectionId]:string } = { home: 'Home', movies: 'Movies', shows: 'TV shows' };

type Entry = RowEntry & { label?:string, new?:boolean };

// The profile's rows of a section (docs/rows-plan.md §8), in Settings › Rows:
// every entry of its layout (its own, else the admin's default, plugins that
// joined since included) as a line of its own (a pxStackItem holding a pxGrid
// of Up / Down / Hide (Show)), and Reset to default. Like every setting, a
// change is saved by itself (PUT /sections/{section}/layout, half a second
// after the last one); the server's `rows.changed` makes the section ask for
// its rows again. Reset asks the server at once.
@Component({
  selector: 'rows-editor',
  templateUrl: './rows-editor.component.html',
  styleUrls: ['./rows-editor.component.scss']
})
export class RowsEditorComponent implements OnChanges, OnDestroy {

  @Input() section:SectionId = 'home';
  // the entry to start on (Edit rows… on a row's menu)
  @Input() focusRow:string | null = null;

  entries:Entry[] | null = null;
  known:string[] = [];
  own = false;
  failed = false;
  private saves = new Subject<SectionId>();
  private subs:Subscription[] = [];
  private loadSub:Subscription | null = null;

  constructor(
    private sections:SectionRowsService,
    private engine:FocusEngine,
    private toasts:Toasts,
  ) {
    // one PUT per pause, in order (the answer's `known` goes with the next one)
    this.subs.push(this.saves.pipe(
      debounceTime(500),
      filter(section => section == this.section && !!this.entries),
      concatMap(section => this.sections.saveLayout(section, this.entries.map(({ label, new: added, ...entry }) => entry as RowEntry), this.known)),
    ).subscribe({
      next: layout => {
        this.known = layout.known;
        this.own = layout.own;
      },
      error: () => this.toasts.show({ text: 'Couldn\'t save the rows', tone: 'error', key: 'rows' }),
    }));
  }

  get name():string {
    return SECTION_NAMES[this.section];
  }

  ngOnChanges(): void {
    this.entries = null;
    this.failed = false;
    this.loadSub?.unsubscribe();
    this.loadSub = this.sections.layout(this.section).subscribe({
      next: layout => {
        this.entries = layout.rows;
        this.known = layout.known;
        this.own = layout.own;
        if (this.focusRow) this.refocus(`hide:${this.focusRow}`);
        this.focusRow = null;
      },
      error: () => this.failed = true,
    });
  }

  ngOnDestroy(): void {
    this.loadSub?.unsubscribe();
    this.subs.forEach(s => s.unsubscribe());
  }

  byId(i:number, e:Entry) {
    return e.id;
  }

  move(entry:Entry, step:number) {
    let list = this.entries;
    let at = list.indexOf(entry);
    let to = at + step;
    if (to < 0 || to >= list.length) return;
    list.splice(at, 1);
    list.splice(to, 0, entry);
    this.saves.next(this.section);
    this.refocus(`${step < 0 ? 'up' : 'down'}:${entry.id}`);
  }

  toggle(entry:Entry) {
    let at = this.entries.indexOf(entry);
    this.entries[at] = { ...entry, hidden: !entry.hidden };
    this.saves.next(this.section);
    this.refocus(`hide:${entry.id}`);
  }

  // the moved / changed entry's button keeps the focus (and the list scrolls to it)
  private refocus(key:string) {
    setTimeout(() => {
      let el = document.querySelector(`.rowsEditor [data-px-key="${CSS.escape(key)}"]`) as HTMLElement;
      if (el) this.engine.focus(el, 'key');
    });
  }

  reset() {
    this.sections.resetLayout(this.section).subscribe({
      next: layout => {
        this.toasts.show({ text: `${this.name} has the usual rows again`, key: 'rows' });
        this.entries = layout.rows;
        this.known = layout.known;
        this.own = false;
        this.refocus(this.entries.length ? `hide:${this.entries[0].id}` : '');
      },
      error: () => this.toasts.show({ text: 'Couldn\'t reset the rows', tone: 'error', key: 'rows' }),
    });
  }
}
