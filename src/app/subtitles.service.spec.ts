import { TestBed } from '@angular/core/testing';

import { SubtitlesService } from './subtitles.service';

describe('SubtitlesService', () => {
  let service: SubtitlesService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SubtitlesService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
