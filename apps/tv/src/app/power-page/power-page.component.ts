import { PowerService } from './../power.service';
import { Component, AfterViewInit } from '@angular/core';

// Quit / Sleep / Shutdown / Restart (core.power, src/app/nav): the last step
// back out of a section. Back closes it (the nav system's pop); the menu is
// hidden here by the screen's chrome
@Component({
  selector: 'power-page',
  templateUrl: './power-page.component.html',
  styleUrls: ['./power-page.component.scss']
})
export class PowerPageComponent implements AfterViewInit {

  constructor(private power:PowerService) { }

  ngAfterViewInit(): void {

    let powerBtn = document.querySelector(".powerBtn") as HTMLElement;
    let menuItems = document.querySelectorAll(".menuItem");

    menuItems.forEach(menuItem => {
      (menuItem as HTMLElement).classList.remove('focused');
    });
    powerBtn.focus({preventScroll : true});
    powerBtn.classList.add("focused");
    // section `powerControls` is a pxSection in the template
  }

  send(instruction:string){
    this.power.sendPowerInstruction(instruction).subscribe();
  }

}
