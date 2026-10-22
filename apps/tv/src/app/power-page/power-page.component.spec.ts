import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PowerPageComponent } from './power-page.component';
import { PxButtonComponent } from '../ui/public-api';
import { PxItemDirective } from '../movement/px-item.directive';

describe('PowerPageComponent', () => {
  let component: PowerPageComponent;
  let fixture: ComponentFixture<PowerPageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ PowerPageComponent, PxButtonComponent, PxItemDirective ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PowerPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
