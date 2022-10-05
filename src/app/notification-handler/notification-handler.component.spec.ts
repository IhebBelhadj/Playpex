import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NotificationHandlerComponent } from './notification-handler.component';

describe('NotificationHandlerComponent', () => {
  let component: NotificationHandlerComponent;
  let fixture: ComponentFixture<NotificationHandlerComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ NotificationHandlerComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(NotificationHandlerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
