# <img src="https://i.ibb.co/wSwD1nB/logo-1.png" alt="Playpex logo" width="50"/> Playpex

Playpex is a media streaming platform with a 10-foot user interface with spacial navigation

![Playpex screenshot](https://lh3.google.com/u/0/d/1jK9GYpN7wBCWFx0oda4nn6M--ZgYxbe2)

> Watch this Youtube video for [Playpex App Promo](https://www.youtube.com/watch?v=mj4EjDdVXTo)

## How it works under the hood

Playpex uses a local server initiated by the electron runtime on application bootstrap to take care of streaming torrents
>Disclaimer :
    This app is done for educational purposes and not intended for commercial use as it is illegal to stream pirated movies and shows

### How streaming works ?

The Streaming part works using **media source extentions (MSE)** and :

1. Appending a request listeners on the server for byte range requests
2. Sending an event to the torrent streamer to prioritize that byte range 
3. Set the response headers and wait for data
4. Pump the stream of downloaded data to the client that way you download the content from the Torrent Streamer and pump the downloaded content back to the client at the same time

### The server part

You can check the [playpex server repo](https://github.com/IhebBelhadj/Playpex-backend) if you are intrested in the server implementation of playpex which provides a **Ready to use API for streaming torrents**

### The client side

The client side is built with **angular v14**

The inerface works with spacial navigation(Navigation with keyboad) to simulate the TV app experience and in the next update i'm working on adding a remote app to download on your phone

## State management solution

Playpex uses services and behavior subjects to manage state including 
* focused element
* fetched movies for each categorie
* last selected movie from each category and more

This ensures a smooth navigation between routes

### How to use Playpex

You can build the app from scratch after cloning the app or download the compressed version ready to use [here](https://mega.nz/file/V80xwTyJ#VrSX1fnlIuXL0ghFYE65Qyi-Y1RqOIt-2Vaf2ysohgE)

## Future updates

* Adding remote controller app for mobile devices (cross platform using ionic )
* Using RXJS for managing state
* Recreating module structure and implementing lazy loading to get a better app performance
* Adding account logging and saving movies to watch later and track watched movies
* Add Tv shows section and account management section
