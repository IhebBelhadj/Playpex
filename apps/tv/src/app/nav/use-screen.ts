import { ElementRef, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Navigator } from './navigator.service';
import { ScreenRef, ScreenRefKind } from './screen-ref';

// In a routed screen component's field initializer (Angular 14: inject()):
//   private screen = useScreen<{ id:string }, Movie>();
export function useScreen<P = Record<string, string>, D = any>():ScreenRef<P, D> {
  return attach<P, D>('screen');
}

// In a frame (a routed component hosting several screens, e.g. movies-page):
// bound to whichever of its screens is shown; its handlers run after the
// screen's
export function useFrame<P = Record<string, string>, D = any>():ScreenRef<P, D> {
  return attach<P, D>('frame');
}

function attach<P, D>(kind:ScreenRefKind):ScreenRef<P, D> {
  return inject(Navigator).attach(inject(ActivatedRoute), inject(ElementRef).nativeElement, kind) as unknown as ScreenRef<P, D>;
}
