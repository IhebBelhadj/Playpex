import { Subscription } from 'rxjs';
import { PowerService } from './../power.service';
import { Router } from '@angular/router';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, OnDestroy, AfterViewInit } from '@angular/core';
import { Location } from '@angular/common';
import { MenuServiceService } from '../menu-service.service';

@Component({
  selector: 'power-page',
  templateUrl: './power-page.component.html',
  styleUrls: ['./power-page.component.scss']
})
export class PowerPageComponent implements AfterViewInit , OnDestroy{

  navSub:Subscription;
  powersub:Subscription;

  constructor(
    private navigation:NavigationService,
    private router:Router,
    private menuService:MenuServiceService,
    private location:Location,
    private power:PowerService,
    ) {

    }

  ngAfterViewInit(): void {

    let powerBtn = document.querySelector(".powerBtn") as HTMLElement;
    let menuItems = document.querySelectorAll(".menuItem");

    menuItems.forEach(menuItem => {
      (menuItem as HTMLElement).classList.remove('focused');
    });
    powerBtn.focus({preventScroll : true});
    powerBtn.classList.add("focused");
    this.menuService.sendInstruction('hide' , this);
    this.navigation.updateNavigation('add' , {
      id: 'powerControls',
      selector: '.powerSection .powerBtn',
      straightOnly: true,
    })

    this.navSub = this.navigation.executeCommand().subscribe(instruction =>{
      if (this.router.url != "/power") return;
      if (instruction == "click") {
        let active = document.activeElement as HTMLElement;

        if (active.classList.contains('powerBtn')) {
          instruction = active.dataset['instruction'];
          console.log(instruction);
          this.powersub = this.power.sendPowerInstruction(instruction).subscribe(data=>{
            this.powersub.unsubscribe();
          })

        }
      }
      if (instruction == "back") {
        this.menuService.sendInstruction('show' , this);

        this.navigation.updateNavigation('remove' , {sectionId : "powerControls"})
        this.location.back();
      }


    })

  }

  ngOnDestroy(): void {
    if (this.navSub) {
      this.navSub.unsubscribe();
    }
  }

}
