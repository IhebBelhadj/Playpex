import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DescritionViewerComponent } from './descrition-viewer.component';

describe('DescritionViewerComponent', () => {
  let component: DescritionViewerComponent;
  let fixture: ComponentFixture<DescritionViewerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ DescritionViewerComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(DescritionViewerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
