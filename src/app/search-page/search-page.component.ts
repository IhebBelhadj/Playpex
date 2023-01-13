import { Router } from '@angular/router';
import { MoviesService } from './../movies.service';
import { BackgroundService } from './../background.service';
import { first, Subscription } from 'rxjs';
import { MenuServiceService } from './../menu-service.service';
import { NavigationService } from './../navigation.service';
import { Component, OnInit, OnDestroy } from '@angular/core';
import { Location } from '@angular/common';

@Component({
  selector: 'app-search-page',
  templateUrl: './search-page.component.html',
  styleUrls: ['./search-page.component.scss']
})
export class SearchPageComponent implements OnInit , OnDestroy {

  navSub:Subscription;
  searchedMovies;
  addedResNav = false;
  movieImgBase = "https://image.tmdb.org/t/p/w154";
  searchQuery = "";

  horizontalScroll = {
    value : 0
  }

  selectedMovie = {
    index : undefined
  };
  inputValue;
  focusListener;
  constructor(
    private navigation:NavigationService,
    private menuService:MenuServiceService,
    private backgroundService:BackgroundService,
    private moviesService:MoviesService,
    private router:Router,
    private location:Location,
  ) { }

  ngOnInit(): void {
    this.setupNavigation();
    let searchTab = document.querySelector('[data-destination="searchPage"]') as HTMLElement;
    searchTab.classList.remove('focused')
    setTimeout(()=>{
      this.menuService.sendInstruction('hide' , this);
    } , 0)
    console.log(this.moviesService.searchData.value);

    this.searchQuery = this.moviesService.searchData.value['query'];
    this.searchedMovies = this.moviesService.searchData.value['results'];

    this.horizontalScroll = {value :this.moviesService.searchData.value['sectionScroll']};
    console.log(this.horizontalScroll);

    if (this.moviesService.searchData.value['lastFocused']) {
      let index = this.moviesService.searchData.value['lastFocused'];
      setTimeout(()=>{
        let node = document.querySelector('[data-id="'+ index +'"]')as HTMLElement
        node.focus({preventScroll : true})

        let container = node.closest('.content') as HTMLElement;

        this.updateSliderScrollX(container , this.horizontalScroll.value)

      } , 200)
    }


    if (!this.addedResNav) {
      this.addedResNav = true;
      this.navigation.updateNavigation('add' , {
        id: 'searches',
        selector: '.resultsWrapper .displayedElem',
        leaveFor : {
          bottom : "@searches"
        },
        straightOnly: true,
      })
    }


    this.navSub = this.navigation.executeCommand().subscribe(instruction=>{
      if(!(this.router.url == "/search")) return;

      if (
        document.activeElement.classList.contains('keyboardBtn') &&
        instruction == "click") {

        let input = document.querySelector('.inputValue') as HTMLElement;

        switch (document.activeElement['dataset']["fct"]) {
          case "del":
            input['value'] = input['value'].slice(0, -1);
            this.onInputChange(input)

            break;
          case "space":
            input['value'] += " ";
            this.onInputChange(input)

            break;
          case "num":
            this.switchToNum()
            break;
          case "char":
            this.switchToChar()
            break;
          default:
             document.querySelector('.inputValue')['value'] += document.activeElement.textContent;
             this.onInputChange(input)
            break;
        }

      }

      if (
        instruction == "click" &&
        document.activeElement.parentElement.classList.contains('movie')
        ) {

          let currentlySelected = document.activeElement as HTMLElement


          this.moviesService.updateSearchData(
            this.searchQuery ,
            this.searchedMovies ,
            {
              index : currentlySelected.dataset['id'],
              sectionScroll : this.horizontalScroll.value,
            }

          );

          let tempSub = this.moviesService.getTmdbMovieDetails(currentlySelected.dataset['id'])
            .pipe(first())
            .subscribe(data=>{

              tempSub.unsubscribe();
              this.navSub.unsubscribe();


              this.moviesService.addMovieToHistory(data);
              this.router.navigateByUrl(`/movies/movie/${data['id']}`);
            })


      }

      if (
        instruction == 'back' &&
        this.router.url == "/search"
      ) {
        this.moviesService.updateSearchData("" , {})
        this.location.back();
      }
    })


    this.focusListener = window.addEventListener('sn:focused', (e)=>{

      if(!(this.router.url == "/search")) return;

      const node = e.target as HTMLElement;

      if (node['parentElement']['classList'].contains('movie') ) {

        this.sectionNavigationSetup(node ,
          '.movieSlider' ,
          this.horizontalScroll,
          this.selectedMovie,
        )


      }
    })
  }

  ngOnDestroy(): void {
    this.menuService.sendInstruction('show' , this);
    if (this.navSub) {
      this.navSub.unsubscribe();
    }

    document.removeEventListener('sn:focused',this.focusListener);
    this.navigation.updateNavigation('remove' , {sectionId : 'keyboard'});
    this.navigation.updateNavigation('remove' , {sectionId : 'searches'});

    this.addedResNav = false;
  }

  setupNavigation(){
    this.navigation.updateNavigation('add' , {
      id: 'keyboard',
      selector: '.keyboardContainer .keyboardBtn',
      leaveFor : {
        bottom : "@searches"
      },
      straightOnly: true,
    })
  }

  onInputChange(e){
    if (e.value.length > 2) {
      this.moviesService.searchMovies(encodeURI(e.value)).subscribe(data=>{
        this.inputValue = e.value;
        this.searchedMovies = data['results'];
        this.moviesService.updateSearchData(e.value , this.searchedMovies);


      })
    }

  }

  switchToNum() {
    let numKeyboard = document.querySelector('.numKeyboard') as HTMLElement;
    let charKeyboard = document.querySelector('.charKeyboard') as HTMLElement;

    let switchNumKey = document.querySelector('.switchNumKey') as HTMLElement;
    let switchCharKey = document.querySelector('.switchCharKey') as HTMLElement;

    numKeyboard.style.display = "grid";
    charKeyboard.style.display = "none";

    switchCharKey.style.display = "block";
    switchNumKey.style.display = "none";

    switchCharKey.focus({preventScroll : true})


  }

  switchToChar() {
    let numKeyboard = document.querySelector('.numKeyboard') as HTMLElement;
    let charKeyboard = document.querySelector('.charKeyboard') as HTMLElement;

    let switchNumKey = document.querySelector('.switchNumKey') as HTMLElement;
    let switchCharKey = document.querySelector('.switchCharKey') as HTMLElement;

    charKeyboard.style.display = "grid";
    numKeyboard.style.display = "none";

    switchNumKey.style.display = "block";
    switchCharKey.style.display = "none";

    switchNumKey.focus({preventScroll : true})

  }


  sectionNavigationSetup(
    node:HTMLElement ,
    parentClass:string ,
    horizontalScrollAmount:{
      value:number
    },
    selectedItem
  ){
    let nodes = document.querySelectorAll(parentClass + ' .displayedElem');

    if (!selectedItem['index']) {
      selectedItem['index'] = node.dataset['index'];
    }

    let container = node.closest('.content') as HTMLElement;

    //Horizontal scroll


    if (Number(node.dataset['index']) > Number(selectedItem['index'])) {


      let rightDiff = node.getBoundingClientRect().right - screen.width;


      if (Math.abs(rightDiff) < (3*screen.width/4) && !this.isInViewport(nodes[nodes.length -1])) {

        horizontalScrollAmount.value +=  node.offsetWidth;


        this.updateSliderScrollX(container , horizontalScrollAmount.value)

      }

    }

    else if(Number(node.dataset['index']) < Number(selectedItem['index'])){

      let leftDiff = node.getBoundingClientRect().left;

      if (Math.abs(leftDiff) < (screen.width/4)) {

        horizontalScrollAmount.value -=  node.clientWidth;
        if (horizontalScrollAmount.value < 0) horizontalScrollAmount.value = 0;
        this.updateSliderScrollX(container , horizontalScrollAmount.value)
      }


    }

    selectedItem['index'] = node.dataset['index'];
  }

  updateSliderScrollX(container:HTMLElement , value){
    container.style.transform = `translateX(-${value}px)`
  }

  isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)

    );
  }

}
