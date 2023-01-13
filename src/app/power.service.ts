import { Injectable } from '@angular/core';
import { HttpClient } from "@angular/common/http";
@Injectable({
  providedIn: 'root'
})
export class PowerService {

  constructor(private http:HttpClient) { }

  sendPowerInstruction(instruction){
    return this.http.get("http://localhost:3344/power/"+instruction);
  }
}
