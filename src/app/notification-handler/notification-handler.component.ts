import { NavigationService } from './../navigation.service';
import { NotificationService } from './../notification.service';
import { Component, OnInit } from '@angular/core';

@Component({
  selector: 'notification-handler',
  templateUrl: './notification-handler.component.html',
  styleUrls: ['./notification-handler.component.scss']
})
export class NotificationHandlerComponent implements OnInit {
  displayError = false;
  errorContent = "";
  constructor(
    private notificationService:NotificationService,
    private navigation:NavigationService,
    ) { }

  ngOnInit(): void {

    this.notificationService.getNotification().subscribe((notification)=>{
      if(notification.type == "error"){
        this.displayError = true;

        let errorHandler = document.querySelector('.errorHandler') as HTMLElement;
        let okBtn = document.querySelector('.errorWrapper .okBtn') as HTMLElement;

        errorHandler.style.display = 'block';
        this.navigation.updateNavigation('add' , {
          id: 'okBtn',
          selector: '.errorWrapper .okBtn',
          restrict : "self-only",
        })
        setTimeout(()=>{
          console.log(okBtn);

          okBtn.focus({preventScroll:true})
        } , 100)

        this.navigation.executeCommand().subscribe(instruction =>{
          if (instruction == "click" && document.activeElement.classList.contains('okBtn')) {
              errorHandler.style.display = 'none';
              this.navigation.updateNavigation('remove' , {sectionId : 'okBtn'});

          }
        })
        this.errorContent = notification.data;
      }
    })
  }

}
