import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { SectionId } from '../catalog';
import { FocusEngine } from '../movement/movement';
import { RowEntry, SectionRowsService } from '../sections.service';
import { Toasts } from '../ui/public-api';

const NAMES:{ [section in SectionId]:string } = { home: 'Home', movies: 'Movies', shows: 'TV shows' };

type Entry = RowEntry & { label?:string, new?:boolean };

// The profile's rows of a section (docs/rows-plan.md §8): every entry of its
// layout (its own, else the admin's default, plugins that joined since
// included) with Move up / Move down / Hide (Show), and Reset to default.
// Saved once, on Done or Back, when something changed (PUT
// /sections/{section}/layout); Reset asks the server at once. On the
// <px-panel> frame: a layer of the nav system, trapping its section
// `rowsEditor`; the entries are one pxGrid of three buttons a line.
@Component({
  selector: 'rows-editor',
  templateUrl: './rows-editor.component.html',
  styleUrls: ['./rows-editor.component.scss']
})
export class RowsEditorComponent implements OnInit {

  @Input() section:SectionId = 'movies';
  // the entry to start on (the row the options key was pressed on)
  @Input() focusRow:string | null = null;
  // true: the rows changed (the section asks for them again)
  @Output() closed = new EventEmitter<boolean>();

  entries:Entry[] | null = null;
  known:string[] = [];
  own = false;
  failed = false;
  private changed = false;
  private saving = false;

  constructor(
    private sections:SectionRowsService,
    private engine:FocusEngine,
    private toasts:Toasts,
  ) { }

  get title():string {
    return `Rows on ${NAMES[this.section]}`;
  }

  get focus():string {
    return this.focusRow ? `[data-px-key="hide:${this.focusRow}"]` : '[data-px-key^="hide:"]';
  }

  ngOnInit(): void {
    this.sections.layout(this.section).subscribe({
      next: layout => this.take(layout),
      error: () => this.failed = true,
    });
  }

  private take(layout:{ rows:Entry[], known:string[], own:boolean }) {
    this.entries = layout.rows;
    this.known = layout.known;
    this.own = layout.own;
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
    this.changed = true;
    this.refocus(`${step < 0 ? 'up' : 'down'}:${entry.id}`);
  }

  toggle(entry:Entry) {
    let at = this.entries.indexOf(entry);
    this.entries[at] = { ...entry, hidden: !entry.hidden };
    this.changed = true;
    this.refocus(`hide:${entry.id}`);
  }

  // the moved / changed entry's button keeps the focus (and the list scrolls to it)
  private refocus(key:string) {
    setTimeout(() => {
      let el = document.querySelector(`#rowsEditor [data-px-key="${CSS.escape(key)}"]`) as HTMLElement;
      if (el) this.engine.focus(el, 'key');
    });
  }

  done() {
    if (this.saving) return;
    if (!this.changed || !this.entries) {
      this.closed.emit(false);
      return;
    }
    this.saving = true;
    let rows = this.entries.map(({ label, new: added, ...entry }) => entry as RowEntry);
    this.sections.saveLayout(this.section, rows, this.known).subscribe({
      next: () => this.closed.emit(true),
      error: () => {
        this.saving = false;
        this.toasts.show({ text: 'Couldn\'t save the rows', tone: 'error', key: 'rows' });
      },
    });
  }

  reset() {
    if (this.saving) return;
    this.saving = true;
    this.sections.resetLayout(this.section).subscribe({
      next: () => {
        this.toasts.show({ text: `${NAMES[this.section]} has the usual rows again`, key: 'rows' });
        this.closed.emit(true);
      },
      error: () => {
        this.saving = false;
        this.toasts.show({ text: 'Couldn\'t reset the rows', tone: 'error', key: 'rows' });
      },
    });
  }
}
