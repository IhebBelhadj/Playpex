import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'clock',
  templateUrl: './clock.component.html',
  styleUrls: ['./clock.component.scss']
})
export class ClockComponent implements OnInit {

  time;
  constructor() { }

  ngOnInit(): void {
    this.currentTime()
  }

  currentTime() {
    let date = new Date();
    let hh = date.getHours();
    let mm = date.getMinutes();
    let session = "AM";

    if(hh === 0){
        hh = 12;
    }
    if(hh > 12){
        hh = hh - 12;
        session = "PM";
     }

     let display_mm = (mm < 10) ? "0" + mm : mm;

     this.time = hh + ":" + display_mm  + ' ' + session;

    setTimeout(()=>{
       this.currentTime()
    }, 10000);

  }

}
