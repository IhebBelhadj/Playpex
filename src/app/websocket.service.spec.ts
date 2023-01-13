import { TestBed } from '@angular/core/testing';

import { RemoteService } from './remoteSocket.service';

describe('WebsocketService', () => {
  let service: RemoteService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RemoteService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
