import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SubtitlesService {

  constructor(private http:HttpClient) { }

  getSubtitles(tmdb_id , languages?){
    return this.http.get(`/api/subtitles/${tmdb_id}` ,
    {
    params : {
      languages : languages
    }
    })
  }

}
