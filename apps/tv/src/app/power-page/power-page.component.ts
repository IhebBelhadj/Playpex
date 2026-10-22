import { PowerService } from './../power.service';
import { Component, AfterViewInit } from '@angular/core';
import { dp } from '../ui/public-api';

// Quit / Sleep / Shutdown / Restart (core.power, src/app/nav): the last step
// back out of a section. Back closes it (the nav system's pop); the menu is
// hidden here by the screen's chrome
@Component({
  selector: 'power-page',
  templateUrl: './power-page.component.html',
  styleUrls: ['./power-page.component.scss']
})
export class PowerPageComponent implements AfterViewInit {

  readonly width = dp(380);

  constructor(private power:PowerService) { }

  ngAfterViewInit(): void {

    let powerBtn = document.querySelector(".powerSection [data-px-key]") as HTMLElement;
    let menuItems = document.querySelectorAll(".menuItem");

    menuItems.forEach(menuItem => {
      (menuItem as HTMLElement).classList.remove('focused');
    });
    powerBtn?.focus({preventScroll : true});
    powerBtn?.classList.add("focused");
    // section `powerControls` is a pxSection in the template
  }

  send(instruction:string){
    this.power.sendPowerInstruction(instruction).subscribe();
  }

}
