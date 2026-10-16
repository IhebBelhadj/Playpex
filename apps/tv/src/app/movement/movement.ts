// The movement system (docs/movement-system-plan.md, src/app/CLAUDE.md
// "Movement system"): focus movement and native scrolling shared by the pages.
import { PxGridDirective } from './px-grid.directive';
import { PxItemDirective, PxStackItemDirective, PxTrackDirective } from './px-item.directive';
import { PxRowDirective } from './px-row.directive';
import { PxSectionDirective } from './px-section.directive';
import { PxStackDirective } from './px-stack.directive';

export { FocusEngine, FocusCause, InputKind, LeaveTarget } from './focus-engine.service';
export { PositionStore, Position } from './position-store.service';
export { Scroller, Align } from './scroller';
export { Motion, MotionKind, ScrollMotion, TransformMotion } from './motion';
export { PxContainer } from './px-container';
export { PxGridDirective, PxItemDirective, PxStackItemDirective, PxTrackDirective, PxRowDirective, PxSectionDirective, PxStackDirective };

// Declared in AppModule
export const MOVEMENT_DIRECTIVES = [
  PxItemDirective,
  PxStackItemDirective,
  PxTrackDirective,
  PxRowDirective,
  PxGridDirective,
  PxStackDirective,
  PxSectionDirective,
];
