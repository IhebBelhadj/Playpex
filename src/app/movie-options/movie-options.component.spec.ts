import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MovieOptionsComponent } from './movie-options.component';

describe('MovieOptionsComponent', () => {
  let component: MovieOptionsComponent;
  let fixture: ComponentFixture<MovieOptionsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ MovieOptionsComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MovieOptionsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
